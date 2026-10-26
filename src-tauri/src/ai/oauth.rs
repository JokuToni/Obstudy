#![allow(non_snake_case)]

use super::{
    AiError, AiIntegration, AiModel, AiResponse, AiState, credential, providers, rate_limits,
    storage,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex as AsyncMutex, Notify},
};
use uuid::Uuid;

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const TOKEN_ENDPOINT: &str = "https://auth.openai.com/api/accounts/oauth/token";
const SESSION_KEY: &str = "openai-oauth-session";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

#[derive(Default)]
pub struct OauthState {
    sessionLock: AsyncMutex<()>,
    pending: Mutex<Option<Arc<Notify>>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Registration {
    clientId: String,
    subject: Option<String>,
    email: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    registration: Registration,
    accessToken: String,
    refreshToken: Option<String>,
    idToken: String,
    scopes: Vec<String>,
    expiresAt: u64,
}

#[derive(Serialize)]
pub struct OauthAccount {
    email: Option<String>,
    planEnabled: bool,
    connected: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Identity {
    sub: String,
    nonce: Option<String>,
    email: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn auth_error(message: &str) -> AiError {
    AiError::new("authentication", message)
}
fn network_error() -> AiError {
    AiError::new(
        "network",
        "Unable to reach OpenAI. Check your connection and try again.",
    )
}
fn random_secret() -> String {
    // Three OS-generated UUIDs provide 366 random bits in a valid PKCE verifier.
    let mut bytes = Vec::with_capacity(48);
    for _ in 0..3 {
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    URL_SAFE_NO_PAD.encode(bytes)
}
fn plan_enabled(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| scope == "chatgpt.tokens.use.direct")
}
fn account(session: &Session) -> OauthAccount {
    OauthAccount {
        email: session.registration.email.clone(),
        planEnabled: plan_enabled(&session.scopes),
        connected: true,
    }
}
async fn read_session(app: tauri::AppHandle) -> Result<Option<Session>, AiError> {
    tauri::async_runtime::spawn_blocking(move || {
        match credential(&app, SESSION_KEY)?.get_password() {
            Ok(value) => serde_json::from_str(&value)
                .map(Some)
                .map_err(|_| auth_error("Saved ChatGPT credentials are invalid. Sign in again.")),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AiError::new(
                "credentials",
                "Unlock the system credential store to use ChatGPT sign-in.",
            )),
        }
    })
    .await
    .map_err(|_| AiError::new("credentials", "Unable to read ChatGPT credentials."))?
}
async fn save_session(app: tauri::AppHandle, session: Session) -> Result<(), AiError> {
    let registration = json!(session.registration);
    let scopes = session.scopes.clone();
    let expiresAt = session.expiresAt;
    let keyApp = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let value = serde_json::to_string(&session)
            .map_err(|_| AiError::new("credentials", "Unable to encode ChatGPT credentials."))?;
        credential(&keyApp, SESSION_KEY)?
            .set_password(&value)
            .map_err(|_| {
                AiError::new(
                    "credentials",
                    "Unable to save ChatGPT credentials in the system credential store.",
                )
            })
    })
    .await
    .map_err(|_| AiError::new("credentials", "Unable to save ChatGPT credentials."))??;
    storage::record_session(&app, &registration, &scopes, expiresAt).await
}
async fn clear_session(app: tauri::AppHandle) -> Result<(), AiError> {
    let keyApp = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match credential(&keyApp, SESSION_KEY)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AiError::new(
                "credentials",
                "Unable to remove ChatGPT credentials from the system credential store.",
            )),
        }
    })
    .await
    .map_err(|_| AiError::new("credentials", "Unable to remove ChatGPT credentials."))??;
    storage::record_sign_out(&app).await
}
async fn saved_registration(app: &tauri::AppHandle) -> Result<Option<Registration>, AiError> {
    storage::read_json(app, "oauthRegistration")
        .await?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| auth_error("The saved ChatGPT registration is invalid."))
}
async fn save_registration(
    app: &tauri::AppHandle,
    registration: &Registration,
) -> Result<(), AiError> {
    storage::write_json(app, "oauthRegistration", &json!(registration)).await
}

pub(super) async fn restored_integration(
    app: tauri::AppHandle,
) -> Result<Option<AiIntegration>, AiError> {
    let session = read_session(app.clone()).await?;
    if let Some(session) = &session {
        storage::record_session(
            &app,
            &json!(session.registration),
            &session.scopes,
            session.expiresAt,
        )
        .await?;
    }
    Ok(session
        .filter(|session| plan_enabled(&session.scopes))
        .map(|_| AiIntegration {
            id: "openaiOauth".into(),
            provider: super::AiProvider::OpenaiOauth,
            model: String::new(),
            maxOutputTokens: 4096,
            reasoningEffort: None,
        }))
}

async fn discovery(client: &Client) -> Result<Value, AiError> {
    let response = client
        .get(format!("{ISSUER}/.well-known/openid-configuration"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| network_error())?;
    if !response.status().is_success() {
        return Err(network_error());
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| auth_error("OpenAI returned invalid sign-in configuration."))?;
    if body["issuer"] != ISSUER {
        return Err(auth_error("OpenAI sign-in issuer did not match."));
    }
    Ok(body)
}
fn trusted_auth_url(value: &Value) -> Result<Url, AiError> {
    let url = Url::parse(value.as_str().unwrap_or(""))
        .map_err(|_| auth_error("OpenAI returned an invalid authentication endpoint."))?;
    if url.scheme() != "https"
        || url.host_str() != Some("auth.openai.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(auth_error(
            "OpenAI returned an unexpected authentication endpoint.",
        ));
    }
    Ok(url)
}
async fn validate_identity(
    client: &Client,
    idToken: &str,
    clientId: &str,
    nonce: Option<&str>,
) -> Result<Identity, AiError> {
    let metadata = discovery(client).await?;
    let jwksUrl = trusted_auth_url(&metadata["jwks_uri"])?;
    let response = client
        .get(jwksUrl)
        .send()
        .await
        .map_err(|_| network_error())?;
    if !response.status().is_success() {
        return Err(network_error());
    }
    let keys: JwkSet = response
        .json()
        .await
        .map_err(|_| auth_error("OpenAI returned invalid signing keys."))?;
    verify_identity(idToken, clientId, nonce, &keys)
}
fn verify_identity(
    idToken: &str,
    clientId: &str,
    nonce: Option<&str>,
    keys: &JwkSet,
) -> Result<Identity, AiError> {
    let header =
        decode_header(idToken).map_err(|_| auth_error("OpenAI returned an invalid ID token."))?;
    if header.alg != Algorithm::RS256 {
        return Err(auth_error(
            "The OpenAI ID token uses an unexpected signing algorithm.",
        ));
    }
    let key = keys
        .find(
            header
                .kid
                .as_deref()
                .ok_or_else(|| auth_error("The OpenAI ID token has no signing key ID."))?,
        )
        .ok_or_else(|| auth_error("The OpenAI ID token signing key is unknown."))?;
    let key =
        DecodingKey::from_jwk(key).map_err(|_| auth_error("The OpenAI signing key is invalid."))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[clientId]);
    validation.set_issuer(&[ISSUER]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.leeway = 30;
    let claims = decode::<Identity>(idToken, &key, &validation)
        .map_err(|_| auth_error("Unable to verify the OpenAI account identity."))?
        .claims;
    if claims.sub.is_empty() || nonce.is_some_and(|nonce| claims.nonce.as_deref() != Some(nonce)) {
        return Err(auth_error(
            "The OpenAI sign-in identity or nonce did not match.",
        ));
    }
    Ok(claims)
}

fn authorization_url(
    hostId: &str,
    registration: Option<&Registration>,
    redirectUri: &str,
    state: &str,
    nonce: &str,
    verifier: &str,
) -> Url {
    let mut url = Url::parse("https://auth.openai.com/api/accounts/authorize").unwrap();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut query = url.query_pairs_mut();
    query.extend_pairs([
        (
            "client_id",
            registration
                .map(|item| item.clientId.as_str())
                .unwrap_or("dynamic_agent_client"),
        ),
        ("ext_agent_host_id", hostId),
        ("response_type", "code"),
        ("redirect_uri", redirectUri),
        ("scope", SCOPES),
        ("resource", RESOURCE),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge),
    ]);
    if let Some(registration) = registration {
        if let Some(email) = &registration.email {
            query.append_pair("login_hint", email);
        }
    } else {
        query.append_pair("agent_name_hint", "Obstudy");
    }
    drop(query);
    url
}

fn callback_parameters(
    target: &str,
    redirectUri: &str,
    state: &str,
    registration: Option<&Registration>,
) -> Result<(String, String), AiError> {
    if !target.starts_with('/') || target.starts_with("//") {
        return Err(auth_error("Invalid sign-in callback."));
    }
    let url = Url::parse(&format!(
        "{}{}",
        redirectUri.trim_end_matches("/auth/callback"),
        target
    ))
    .map_err(|_| auth_error("Invalid sign-in callback."))?;
    if url.path() != "/auth/callback" {
        return Err(auth_error("Unexpected sign-in callback path."));
    }
    let mut params = HashMap::new();
    for (name, value) in url.query_pairs() {
        if params
            .insert(name.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(auth_error("Duplicate sign-in callback parameters."));
        }
    }
    if params.get("state").map(String::as_str) != Some(state) {
        return Err(auth_error(
            "The sign-in state did not match. Try signing in again.",
        ));
    }
    if params.contains_key("error") {
        return Err(auth_error(
            "ChatGPT sign-in was declined. You can try again when ready.",
        ));
    }
    let clientId = params
        .get("client_id")
        .cloned()
        .or_else(|| registration.map(|item| item.clientId.clone()))
        .filter(|id| !id.is_empty() && id != "dynamic_agent_client" && id.len() <= 256)
        .ok_or_else(|| {
            auth_error("OpenAI did not finish registering this app. Try signing in again.")
        })?;
    if registration.is_some_and(|item| item.clientId != clientId) {
        return Err(auth_error(
            "The ChatGPT registration did not match the selected account.",
        ));
    }
    let code = params
        .get("code")
        .filter(|code| !code.is_empty())
        .cloned()
        .ok_or_else(|| auth_error("OpenAI returned no authorization code."))?;
    Ok((code, clientId))
}
async fn receive_callback(
    listener: TcpListener,
    redirectUri: &str,
    state: &str,
    registration: Option<&Registration>,
) -> Result<(String, String), AiError> {
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|_| auth_error("Unable to receive the sign-in callback."))?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let request = tokio::time::timeout(Duration::from_secs(3), async {
            let mut data = Vec::new();
            let mut chunk = [0u8; 1024];
            while !data.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).await.ok()?;
                if count == 0 || data.len() + count > 8192 {
                    return None;
                }
                data.extend_from_slice(&chunk[..count]);
            }
            String::from_utf8(data).ok()
        })
        .await
        .ok()
        .flatten();
        let Some(request) = request else {
            continue;
        };
        let mut parts = request.lines().next().unwrap_or("").split_whitespace();
        let method = parts.next();
        let target = parts.next().unwrap_or("");
        let result = if method == Some("GET") {
            callback_parameters(target, redirectUri, state, registration)
        } else {
            Err(auth_error("Invalid callback method."))
        };
        let success = result.is_ok();
        let message = if success {
            "Sign-in received. Return to Obstudy to finish connecting your account."
        } else {
            "This sign-in callback was not accepted. Return to Obstudy and try again."
        };
        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n{message}",
            if success { "200 OK" } else { "400 Bad Request" },
            message.len()
        );
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            stream.write_all(response.as_bytes()),
        )
        .await;
        // Ignore unrelated browser requests, but return explicit refusal for a valid attempt.
        if success || target.contains(&format!("state={state}")) {
            return result;
        }
    }
}

struct PendingGuard<'a>(&'a Mutex<Option<Arc<Notify>>>);
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = None;
        }
    }
}

#[tauri::command]
pub async fn connect_openai_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
) -> Result<OauthAccount, AiError> {
    let cancel = Arc::new(Notify::new());
    {
        let mut pending = state
            .oauth
            .pending
            .lock()
            .map_err(|_| auth_error("Unable to start ChatGPT sign-in."))?;
        if pending.is_some() {
            return Err(auth_error("A ChatGPT sign-in is already in progress."));
        }
        *pending = Some(cancel.clone());
    }
    let _pending = PendingGuard(&state.oauth.pending);
    let _session = state.oauth.sessionLock.lock().await;
    let session = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(180), connect(&app, &state)) => result.map_err(|_| auth_error("ChatGPT sign-in timed out. Try again."))?,
        _ = cancel.notified() => Err(auth_error("ChatGPT sign-in was cancelled.")),
    }?;
    // Once validated, persist the token set together. Cancellation must not interrupt
    // a credential-store write that continues running on a blocking worker.
    save_session(app.clone(), session.clone()).await?;
    save_registration(&app, &session.registration).await?;
    if plan_enabled(&session.scopes) {
        super::remember_oauth_login(&app, &state).await?;
    }
    Ok(account(&session))
}
#[tauri::command]
pub fn cancel_openai_oauth(state: tauri::State<'_, Arc<AiState>>) {
    if let Ok(pending) = state.oauth.pending.lock() {
        if let Some(cancel) = pending.as_ref() {
            cancel.notify_one();
        }
    }
}
async fn connect(app: &tauri::AppHandle, state: &AiState) -> Result<Session, AiError> {
    let hostId = match storage::read_json(app, "oauthHostId")
        .await?
        .and_then(|value| value.as_str().map(str::to_owned))
    {
        Some(value) => value,
        None => {
            let value = format!("urn:uuid:{}", Uuid::new_v4());
            storage::write_json(app, "oauthHostId", &json!(value)).await?;
            value
        }
    };
    let registration = saved_registration(app).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
        auth_error("Unable to open a local sign-in callback. Check local firewall permissions.")
    })?;
    let port = listener
        .local_addr()
        .map_err(|_| auth_error("Unable to read the sign-in callback port."))?
        .port();
    let redirectUri = format!("http://127.0.0.1:{port}/auth/callback");
    let stateValue = random_secret();
    let nonce = random_secret();
    let verifier = random_secret();
    let mut url = authorization_url(
        &hostId,
        registration.as_ref(),
        &redirectUri,
        &stateValue,
        &nonce,
        &verifier,
    );
    if read_session(app.clone())
        .await?
        .is_some_and(|session| !plan_enabled(&session.scopes))
    {
        url.query_pairs_mut().append_pair("prompt", "consent");
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| auth_error("Unable to open the browser for ChatGPT sign-in."))?;
    let (code, clientId) =
        receive_callback(listener, &redirectUri, &stateValue, registration.as_ref()).await?;
    // Retain the issued client ID even if the one-use code later expires.
    if registration.is_none() {
        save_registration(
            app,
            &Registration {
                clientId: clientId.clone(),
                subject: None,
                email: None,
            },
        )
        .await?;
    }
    let response = state
        .client
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", &clientId),
            ("code", &code),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirectUri),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|_| network_error())?;
    let token = read_tokens(response).await?;
    let idToken = token
        .id_token
        .as_deref()
        .ok_or_else(|| auth_error("OpenAI returned no identity token."))?;
    let identity = validate_identity(&state.client, idToken, &clientId, Some(&nonce)).await?;
    if registration
        .as_ref()
        .and_then(|item| item.subject.as_ref())
        .is_some_and(|subject| subject != &identity.sub)
    {
        return Err(auth_error(
            "The signed-in ChatGPT account did not match the saved account.",
        ));
    }
    let registration = Registration {
        clientId,
        subject: Some(identity.sub),
        email: identity.email,
    };
    let session = Session {
        registration: registration.clone(),
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        idToken: idToken.into(),
        scopes: token
            .scope
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        expiresAt: now().saturating_add(token.expires_in),
    };
    Ok(session)
}
async fn read_tokens(response: reqwest::Response) -> Result<TokenResponse, AiError> {
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let code = body["error"]
            .as_str()
            .or_else(|| body["error"]["code"].as_str())
            .unwrap_or("");
        let mut error = auth_error(
            if matches!(
                code,
                "invalid_grant"
                    | "invalid_refresh_token"
                    | "token_expired"
                    | "refresh_token_expired"
                    | "refresh_token_invalidated"
                    | "refresh_token_reused"
            ) {
                "ChatGPT authorization expired or was revoked. Sign in again."
            } else {
                "OpenAI could not authorize this session. Try again or check account eligibility."
            },
        );
        error.status = Some(status);
        if matches!(
            code,
            "invalid_grant"
                | "invalid_refresh_token"
                | "token_expired"
                | "refresh_token_expired"
                | "refresh_token_invalidated"
                | "refresh_token_reused"
        ) {
            error.code = "reauthorizationRequired".into();
        }
        return Err(error);
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| auth_error("OpenAI returned invalid credentials."))?;
    if !token.token_type.eq_ignore_ascii_case("bearer")
        || token.access_token.is_empty()
        || token.expires_in == 0
    {
        return Err(auth_error("OpenAI returned unusable credentials."));
    }
    Ok(token)
}

#[tauri::command]
pub async fn get_openai_oauth_account(
    app: tauri::AppHandle,
) -> Result<Option<OauthAccount>, AiError> {
    Ok(read_session(app).await?.as_ref().map(account))
}
pub async fn require_plan(app: tauri::AppHandle) -> Result<(), AiError> {
    let session = read_session(app)
        .await?
        .ok_or_else(|| auth_error("Continue with ChatGPT before saving this integration."))?;
    if !plan_enabled(&session.scopes) {
        return Err(auth_error(
            "ChatGPT plan usage was not authorized. Continue with ChatGPT and grant plan usage, or choose the API-key integration.",
        ));
    }
    Ok(())
}
pub async fn access_token(app: &tauri::AppHandle, state: &AiState) -> Result<String, AiError> {
    let _guard = state.oauth.sessionLock.lock().await;
    let mut session = read_session(app.clone())
        .await?
        .ok_or_else(|| auth_error("Sign in with ChatGPT to reconnect this integration."))?;
    if !plan_enabled(&session.scopes) {
        return Err(auth_error(
            "Enable ChatGPT plan usage before sending prompts.",
        ));
    }
    if session.expiresAt <= now().saturating_add(60) {
        let refreshToken = session
            .refreshToken
            .as_deref()
            .ok_or_else(|| auth_error("Sign in with ChatGPT again to renew your session."))?;
        let response = state
            .client
            .post(TOKEN_ENDPOINT)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", session.registration.clientId.as_str()),
                ("refresh_token", refreshToken),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| network_error())?;
        let token = match read_tokens(response).await {
            Ok(token) => token,
            Err(error) => {
                if error.code == "reauthorizationRequired" {
                    clear_session(app.clone()).await?;
                }
                return Err(error);
            }
        };
        if let Some(idToken) = token.id_token {
            let identity = validate_identity(
                &state.client,
                &idToken,
                &session.registration.clientId,
                None,
            )
            .await?;
            if session.registration.subject.as_deref() != Some(&identity.sub) {
                return Err(auth_error(
                    "The renewed ChatGPT session belongs to a different account.",
                ));
            }
            session.idToken = idToken;
        }
        session.accessToken = token.access_token;
        session.expiresAt = now().saturating_add(token.expires_in);
        if let Some(refreshToken) = token.refresh_token {
            session.refreshToken = Some(refreshToken);
        }
        if let Some(scope) = token.scope {
            session.scopes = scope.split_whitespace().map(str::to_owned).collect();
        }
        save_session(app.clone(), session.clone()).await?;
        if !plan_enabled(&session.scopes) {
            return Err(auth_error(
                "ChatGPT plan usage is no longer authorized. Sign in again to enable it.",
            ));
        }
    }
    Ok(session.accessToken)
}

#[tauri::command]
pub async fn disconnect_openai_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
) -> Result<bool, AiError> {
    cancel_openai_oauth(state.clone());
    let _guard = state.oauth.sessionLock.lock().await;
    let session = read_session(app.clone()).await?;
    let mut revoked = session.is_none();
    if let Some(session) = session {
        if let Some(refreshToken) = session.refreshToken {
            if let Ok(metadata) = discovery(&state.client).await {
                if let Ok(url) = trusted_auth_url(&metadata["revocation_endpoint"]) {
                    // Bounded retries; a failed revocation never blocks local sign-out forever.
                    for _ in 0..2 {
                        let response = state
                            .client
                            .post(url.clone())
                            .timeout(Duration::from_secs(10))
                            .form(&[
                                ("token", refreshToken.as_str()),
                                ("token_type_hint", "refresh_token"),
                                ("client_id", session.registration.clientId.as_str()),
                            ])
                            .send()
                            .await;
                        if response.is_ok_and(|response| response.status().as_u16() == 200) {
                            revoked = true;
                            break;
                        }
                    }
                }
            }
        }
    }
    clear_session(app).await?;
    Ok(revoked)
}

#[tauri::command]
pub async fn list_openai_oauth_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
) -> Result<Vec<AiModel>, AiError> {
    let token = access_token(&app, &state).await?;
    let response = state
        .client
        .get(format!("{RESOURCE}/models"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| network_error())?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let body: Value = response.json().await.map_err(|_| {
        AiError::new(
            "invalidResponse",
            "OpenAI returned an invalid model catalog.",
        )
    })?;
    let models = parse_models(&body)?;
    super::capabilities::cache_models(&state, super::AiProvider::OpenaiOauth, &models)?;
    Ok(models)
}
fn parse_models(body: &Value) -> Result<Vec<AiModel>, AiError> {
    let models = body["models"].as_array().ok_or_else(|| {
        AiError::new(
            "invalidResponse",
            "OpenAI returned an invalid ChatGPT model catalog.",
        )
    })?;
    Ok(models
        .iter()
        .filter(|model| model["visibility"] == "list")
        .filter_map(|model| {
            model["slug"].as_str().map(|id| AiModel {
                id: id.into(),
                name: model["display_name"].as_str().unwrap_or(id).into(),
                effortLevels: super::capabilities::effort_levels(
                    super::AiProvider::OpenaiOauth,
                    id,
                    model,
                ),
            })
        })
        .collect())
}

pub fn prompt_body(integration: &AiIntegration, prompt: &str) -> Value {
    let mut body = json!({"model": integration.model, "input": [{"role": "user", "content": prompt}], "store": false, "stream": true});
    if let Some(effort) = &integration.reasoningEffort {
        body["reasoning"] = json!({"effort": effort});
    }
    body
}
pub async fn prompt(
    app: &tauri::AppHandle,
    state: &AiState,
    integration: &AiIntegration,
    prompt: &str,
) -> Result<AiResponse, AiError> {
    let token = access_token(app, state).await?;
    let response = state
        .client
        .post(format!("{RESOURCE}/responses"))
        .bearer_auth(token)
        .json(&prompt_body(integration, prompt))
        .send()
        .await
        .map_err(|_| network_error())?;
    read_stream(response, integration).await
}

async fn read_stream(
    mut response: reqwest::Response,
    integration: &AiIntegration,
) -> Result<AiResponse, AiError> {
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let status = response.status().as_u16();
    let limits = rate_limits(response.headers());
    let requestId = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let annotate = |mut error: AiError| {
        error.status = Some(status);
        error.rateLimits = Some(limits.clone());
        error.requestId = requestId.clone();
        error
    };
    let mut buffer = Vec::new();
    let mut eventData = String::new();
    let mut completed = None;
    let mut output = StreamOutput::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| annotate(network_error()))?
    {
        buffer.extend_from_slice(&chunk);
        if buffer.len() > 8 * 1024 * 1024 {
            return Err(AiError::new(
                "invalidResponse",
                "The OpenAI stream event exceeded the supported size.",
            ));
        }
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<_> = buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| {
                    AiError::new(
                        "invalidResponse",
                        "The OpenAI stream contained invalid text.",
                    )
                })?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if let Some(body) = output.process(&eventData).map_err(&annotate)? {
                    completed = Some(body);
                }
                eventData.clear();
            } else if let Some(data) = line.strip_prefix("data:") {
                if !eventData.is_empty() {
                    eventData.push('\n');
                }
                eventData.push_str(data.strip_prefix(' ').unwrap_or(data));
                if eventData.len() > 8 * 1024 * 1024 {
                    return Err(AiError::new(
                        "invalidResponse",
                        "The OpenAI stream event exceeded the supported size.",
                    ));
                }
            }
        }
    }
    if !buffer.is_empty() {
        return Err(AiError::new(
            "incomplete",
            "The ChatGPT response stream was interrupted.",
        ));
    }
    if let Some(body) = output.process(&eventData).map_err(&annotate)? {
        completed = Some(body);
    }
    let body = completed.ok_or_else(|| {
        AiError::new(
            "incomplete",
            "ChatGPT did not finish the response. Try again.",
        )
    })?;
    let body = output.complete(body);
    let mut result = providers::parse_response(integration, &body).map_err(&annotate)?;
    result.rateLimits = limits;
    Ok(result)
}
// Keep streamed output separate from terminal metadata. Never return it without
// response.completed: a text-done event can precede a later failure.
#[derive(Default)]
struct StreamOutput {
    items: BTreeMap<u64, Value>,
    parts: BTreeMap<(u64, u64), Value>,
    deltas: BTreeMap<(u64, u64), String>,
    bufferedBytes: usize,
}
impl StreamOutput {
    fn process(&mut self, data: &str) -> Result<Option<Value>, AiError> {
        if data.is_empty() || data == "[DONE]" {
            return Ok(None);
        }
        let event: Value = serde_json::from_str(data).map_err(|_| {
            AiError::new(
                "invalidResponse",
                "OpenAI returned an invalid stream event.",
            )
        })?;
        let kind = event["type"].as_str().unwrap_or("");
        let outputIndex = event["output_index"].as_u64().unwrap_or(0);
        let contentIndex = event["content_index"].as_u64().unwrap_or(0);
        let key = (outputIndex, contentIndex);
        if matches!(
            kind,
            "response.output_item.done"
                | "response.content_part.done"
                | "response.output_text.done"
                | "response.output_text.delta"
        ) {
            self.bufferedBytes = self.bufferedBytes.saturating_add(data.len());
            if self.bufferedBytes > 32 * 1024 * 1024 {
                return Err(AiError::new(
                    "invalidResponse",
                    "The OpenAI streamed output exceeded the supported size.",
                ));
            }
        }
        match kind {
            "response.completed" => return Ok(Some(event["response"].clone())),
            "response.failed" | "error" => {
                return Err(inference_error(
                    event["response"]["error"]["code"]
                        .as_str()
                        .or_else(|| event["error"]["code"].as_str())
                        .or_else(|| event["code"].as_str())
                        .unwrap_or(""),
                ));
            }
            "response.incomplete" => {
                return Err(AiError::new(
                    "incomplete",
                    "ChatGPT could not complete the response.",
                ));
            }
            "response.refusal.delta" | "response.refusal.done" => {
                return Err(AiError::new(
                    "provider",
                    "The provider declined this request.",
                ));
            }
            "response.output_item.done" => {
                if event["item"]["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["type"] == "refusal"))
                {
                    return Err(AiError::new(
                        "provider",
                        "The provider declined this request.",
                    ));
                }
                if event["item"].is_object() {
                    self.items.insert(outputIndex, event["item"].clone());
                }
            }
            "response.content_part.done" => {
                if event["part"]["type"] == "refusal" {
                    return Err(AiError::new(
                        "provider",
                        "The provider declined this request.",
                    ));
                }
                if event["part"]["type"] == "output_text" {
                    self.parts.insert(key, event["part"].clone());
                }
            }
            "response.output_text.done" => {
                if let Some(text) = event["text"].as_str() {
                    self.parts
                        .insert(key, json!({"type":"output_text", "text":text}));
                }
            }
            "response.output_text.delta" => {
                if let Some(delta) = event["delta"].as_str() {
                    self.deltas.entry(key).or_default().push_str(delta);
                }
            }
            _ => {}
        }
        Ok(None)
    }

    fn complete(mut self, mut body: Value) -> Value {
        if body["status"] != "completed" || !body.is_object() {
            return body;
        }
        // The terminal payload is authoritative where it contains output. Fill
        // omitted content by index, without duplicating text seen in multiple events.
        let terminalItems = body["output"].as_array().cloned().unwrap_or_default();
        for (index, item) in terminalItems.into_iter().enumerate() {
            let key = index as u64;
            let terminalHasContent = item["content"]
                .as_array()
                .is_some_and(|parts| !parts.is_empty());
            if terminalHasContent || !self.items.contains_key(&key) {
                self.items.insert(key, item);
            }
        }
        for (key, text) in self.deltas {
            self.parts
                .entry(key)
                .or_insert_with(|| json!({"type":"output_text", "text":text}));
        }
        for ((outputIndex, contentIndex), part) in self.parts {
            let item = self.items.entry(outputIndex).or_insert_with(|| json!({"type":"message", "role":"assistant", "status":"completed", "content":[]}));
            if item["type"] != "message" {
                continue;
            }
            if !item["content"].is_array() {
                item["content"] = json!([]);
            }
            let content = item["content"].as_array_mut().unwrap();
            // Indexes are provider data; avoid allocating a sparse array from them.
            if let Some(existing) = usize::try_from(contentIndex)
                .ok()
                .and_then(|index| content.get_mut(index))
            {
                if existing["type"] == "output_text"
                    && existing["text"].as_str().is_none_or(|text| text.is_empty())
                {
                    *existing = part;
                }
            } else {
                content.push(part);
            }
        }
        body["output"] = Value::Array(self.items.into_values().collect());
        body
    }
}

#[cfg(test)]
fn parse_event(data: &str) -> Result<Option<Value>, AiError> {
    StreamOutput::default().process(data)
}

fn inference_error(code: &str) -> AiError {
    let (kind, message) = match code {
        "subscription_sharing_usage_limit_exceeded" => (
            "rateLimit",
            "ChatGPT plan usage limit reached. Manage this app’s usage in ChatGPT Settings → Usage.",
        ),
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => (
            "provider",
            "ChatGPT plan usage is temporarily unavailable. Try again later.",
        ),
        "subscription_sharing_user_not_eligible" => (
            "authentication",
            "This ChatGPT account or workspace is not eligible for plan usage.",
        ),
        "subscription_sharing_unsupported_capability" => (
            "provider",
            "This request or model is not supported by ChatGPT plan usage.",
        ),
        "subscription_sharing_invalid_user" => (
            "authentication",
            "ChatGPT could not verify this session. Sign in again.",
        ),
        _ => (
            "provider",
            "ChatGPT rejected the request. Check model access, account permissions, or service availability.",
        ),
    };
    let mut error = AiError::new(kind, message);
    if !code.is_empty()
        && code.len() <= 128
        && code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        error.providerCode = Some(code.into());
    }
    error
}
async fn response_error(response: reqwest::Response) -> AiError {
    let status = response.status().as_u16();
    let limits = rate_limits(response.headers());
    let requestId = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let mut error = inference_error(body["error"]["code"].as_str().unwrap_or(""));
    if error.code == "provider" {
        if status == 429 {
            error.code = "rateLimit".into();
        }
        if status == 401 {
            error.code = "authentication".into();
            error.message = "ChatGPT authentication failed. Sign in again.".into();
        }
    }
    error.status = Some(status);
    error.requestId = requestId;
    error.rateLimits = Some(limits);
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stored_session_retains_refresh_credentials_identity_scopes_and_expiry() {
        let session = Session {
            registration: Registration {
                clientId: "issued-client".into(),
                subject: Some("verified-subject".into()),
                email: Some("test@example.com".into()),
            },
            accessToken: "test-access-token".into(),
            refreshToken: Some("test-refresh-token".into()),
            idToken: "test-id-token".into(),
            scopes: vec!["chatgpt.tokens.use.direct".into(), "offline_access".into()],
            expiresAt: now() + 3600,
        };
        let persisted = serde_json::to_string(&session).unwrap();
        let restored: Session = serde_json::from_str(&persisted).unwrap();
        assert_eq!(restored.refreshToken.as_deref(), Some("test-refresh-token"));
        assert_eq!(restored.registration.clientId, "issued-client");
        assert_eq!(restored.expiresAt, session.expiresAt);
        assert!(account(&restored).connected);
        assert!(account(&restored).planEnabled);
        let public = serde_json::to_string(&account(&restored)).unwrap();
        assert!(!public.contains("test-access-token"));
        assert!(!public.contains("test-refresh-token"));
    }
    #[test]
    fn identity_requires_valid_signature_issuer_audience_expiry_and_nonce() {
        // This fixture is a generated test-only key, never used by the app.
        let key =
            jsonwebtoken::EncodingKey::from_rsa_pem(include_bytes!("fixtures/oauth_test_key.pem"))
                .unwrap();
        let keys: JwkSet =
            serde_json::from_str(include_str!("fixtures/oauth_test_jwks.json")).unwrap();
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        let claims = json!({"sub":"user", "email":"test@example.com", "iss":ISSUER, "aud":"issued", "exp":now()+300, "nonce":"nonce"});
        let token = jsonwebtoken::encode(&header, &claims, &key).unwrap();
        assert_eq!(
            verify_identity(&token, "issued", Some("nonce"), &keys)
                .unwrap()
                .sub,
            "user"
        );
        assert!(verify_identity(&token, "other", Some("nonce"), &keys).is_err());
        assert!(verify_identity(&token, "issued", Some("wrong"), &keys).is_err());
        for field in ["iss", "aud", "exp", "sub", "nonce"] {
            let mut invalid = claims.clone();
            invalid.as_object_mut().unwrap().remove(field);
            let token = jsonwebtoken::encode(&header, &invalid, &key).unwrap();
            assert!(verify_identity(&token, "issued", Some("nonce"), &keys).is_err());
        }
        for (field, value) in [
            ("iss", json!("https://untrusted.example")),
            ("exp", json!(now() - 120)),
            ("sub", json!("")),
        ] {
            let mut invalid = claims.clone();
            invalid[field] = value;
            let token = jsonwebtoken::encode(&header, &invalid, &key).unwrap();
            assert!(verify_identity(&token, "issued", Some("nonce"), &keys).is_err());
        }
        let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
        let mut signature = URL_SAFE_NO_PAD.decode(&parts[2]).unwrap();
        signature[0] ^= 1;
        parts[2] = URL_SAFE_NO_PAD.encode(signature);
        assert!(verify_identity(&parts.join("."), "issued", Some("nonce"), &keys).is_err());
    }

    #[test]
    fn loopback_callback_ignores_unrelated_requests_and_accepts_valid_state() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let uri = format!(
                "http://127.0.0.1:{}/auth/callback",
                listener.local_addr().unwrap().port()
            );
            let callbackUri = uri.clone();
            let task = tauri::async_runtime::spawn(async move {
                receive_callback(listener, &callbackUri, "expected", None).await
            });
            let client = Client::new();
            assert_eq!(
                client
                    .get(format!("{uri}?state=wrong&code=c&client_id=issued"))
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                400
            );
            assert_eq!(
                client
                    .get(format!("{uri}?state=expected&code=c&client_id=issued"))
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                200
            );
            let result = task.await.unwrap().unwrap();
            assert_eq!(result, ("c".into(), "issued".into()));
        });
    }

    async fn read_test_stream(events: Vec<Value>) -> Result<AiResponse, AiError> {
        let integration = AiIntegration {
            id: "oauth".into(),
            provider: super::super::AiProvider::OpenaiOauth,
            model: "selected".into(),
            maxOutputTokens: 4096,
            reasoningEffort: None,
        };
        let body = events
            .into_iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        let response: reqwest::Response = tauri::http::Response::builder()
            .header("x-request-id", "req-stream-test")
            .header("x-ratelimit-remaining-requests", "10")
            .body(body)
            .unwrap()
            .into();
        read_stream(response, &integration).await
    }

    fn completed_event(output: Value) -> Value {
        json!({"type":"response.completed", "response":{"id":"response", "status":"completed", "model":"selected", "output":output, "usage":{"input_tokens":3,"output_tokens":2}}})
    }

    #[test]
    fn streamed_text_survives_missing_terminal_output_from_items_parts_done_or_deltas() {
        tauri::async_runtime::block_on(async {
            let sources = vec![
                vec![
                    json!({"type":"response.output_item.done", "output_index":0, "item":{"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"Answer"}]}}),
                ],
                vec![
                    json!({"type":"response.content_part.done", "output_index":0,"content_index":0,"part":{"type":"output_text", "text":"Answer"}}),
                ],
                vec![
                    json!({"type":"response.output_text.done", "output_index":0,"content_index":0,"text":"Answer"}),
                ],
                vec![
                    json!({"type":"response.output_text.delta", "output_index":0,"content_index":0,"delta":"Ans"}),
                    json!({"type":"response.output_text.delta", "output_index":0,"content_index":0,"delta":"wer"}),
                ],
            ];
            for mut events in sources {
                events.push(completed_event(json!([])));
                let result = read_test_stream(events).await.unwrap();
                assert_eq!(result.text, "Answer");
                assert_eq!(result.usage.totalTokens, 5);
                assert_eq!(
                    result.rateLimits.headers["x-ratelimit-remaining-requests"],
                    "10"
                );
            }
        });
    }

    #[test]
    fn streaming_snapshots_replace_deltas_without_duplication_and_terminal_text_wins() {
        tauri::async_runtime::block_on(async {
            let mut events = vec![
                json!({"type":"response.output_text.delta", "output_index":0,"content_index":0,"delta":"Partial"}),
                json!({"type":"response.output_text.done", "output_index":0,"content_index":0,"text":"Answer"}),
                json!({"type":"response.content_part.done", "output_index":0,"content_index":0,"part":{"type":"output_text", "text":"Answer"}}),
                json!({"type":"response.output_item.done", "output_index":0,"item":{"type":"message", "content":[{"type":"output_text", "text":"Answer"}]}}),
            ];
            let mut sparse = events.clone();
            sparse.push(completed_event(json!([])));
            assert_eq!(read_test_stream(sparse).await.unwrap().text, "Answer");
            events.push(completed_event(
                json!([{"type":"message", "content":[{"type":"output_text", "text":"Canonical"}]}]),
            ));
            assert_eq!(read_test_stream(events).await.unwrap().text, "Canonical");
        });
    }

    #[test]
    fn streamed_text_keeps_output_and_content_order_and_never_returns_reasoning_or_tool_arguments()
    {
        tauri::async_runtime::block_on(async {
            let result = read_test_stream(vec![
                json!({"type":"response.output_item.done", "output_index":0,"item":{"type":"reasoning", "summary":[{"text":"private reasoning"}]}}),
                json!({"type":"response.output_text.done", "output_index":2,"content_index":0,"text":"Third"}),
                json!({"type":"response.output_text.done", "output_index":1,"content_index":1,"text":"Second"}),
                json!({"type":"response.output_text.done", "output_index":1,"content_index":0,"text":"First"}),
                completed_event(json!([])),
            ]).await.unwrap();
            assert_eq!(result.text, "First\nSecond\nThird");
            let error = read_test_stream(vec![
                json!({"type":"response.output_item.done", "output_index":0,"item":{"type":"function_call", "arguments":"private tool arguments"}}),
                completed_event(json!([])),
            ]).await.err().unwrap();
            assert_eq!(error.providerCode.as_deref(), Some("empty_output"));
            assert!(!error.message.contains("private tool arguments"));
        });
    }

    #[test]
    fn finalized_text_still_requires_successful_terminal_response_and_refusals_are_preserved() {
        tauri::async_runtime::block_on(async {
            let done = json!({"type":"response.output_text.done", "output_index":0,"content_index":0,"text":"Partial answer"});
            let error = read_test_stream(vec![done.clone()]).await.err().unwrap();
            assert_eq!(error.code, "incomplete");
            for terminal in [
                json!({"type":"response.incomplete"}),
                json!({"type":"response.failed", "response":{"error":{"code":"server_error"}}}),
                json!({"type":"response.refusal.done","refusal":"Declined"}),
                completed_event(
                    json!([{"type":"message","content":[{"type":"refusal","refusal":"Declined"}]}]),
                ),
            ] {
                assert!(
                    read_test_stream(vec![done.clone(), terminal])
                        .await
                        .is_err()
                );
            }
        });
    }

    #[test]
    fn truly_empty_completed_response_retains_request_identity_and_reports_empty_output() {
        tauri::async_runtime::block_on(async {
            let error = read_test_stream(vec![completed_event(json!([]))])
                .await
                .err()
                .unwrap();
            assert_eq!(error.code, "invalidResponse");
            assert_eq!(error.providerCode.as_deref(), Some("empty_output"));
            assert_eq!(error.requestId.as_deref(), Some("req-stream-test"));
            assert!(error.message.contains("without an assistant text answer"));
            assert_eq!(
                error.rateLimits.unwrap().headers["x-ratelimit-remaining-requests"],
                "10"
            );
        });
    }

    #[test]
    fn oauth_inference_uses_streaming_contract_and_requires_terminal_success() {
        tauri::async_runtime::block_on(async {
            let integration = AiIntegration {
                id: "oauth".into(),
                provider: super::super::AiProvider::OpenaiOauth,
                model: "selected".into(),
                maxOutputTokens: 100,
                reasoningEffort: None,
            };
            let request = prompt_body(&integration, "hello");
            assert_eq!(request["stream"], true);
            assert_eq!(request["store"], false);
            assert_eq!(request["input"][0]["content"], "hello");
            assert!(request.get("max_output_tokens").is_none());
            let completed = json!({"type":"response.completed", "response":{"id":"response", "status":"completed", "model":"selected", "output":[{"type":"message", "content":[{"type":"output_text", "text":"Answer"}]}], "usage":{"input_tokens":3,"output_tokens":2}}});
            let body = format!(
                "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"Answer\"}}\r\n\r\ndata: {completed}\n\n"
            );
            let response: reqwest::Response = tauri::http::Response::builder()
                .header("x-ratelimit-remaining-requests", "10")
                .body(body)
                .unwrap()
                .into();
            let result = read_stream(response, &integration).await.unwrap();
            assert_eq!(result.text, "Answer");
            assert_eq!(result.usage.totalTokens, 5);
            assert_eq!(
                result.rateLimits.headers["x-ratelimit-remaining-requests"],
                "10"
            );
            for body in [
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n",
            ] {
                let response: reqwest::Response =
                    tauri::http::Response::builder().body(body).unwrap().into();
                assert!(read_stream(response, &integration).await.is_err());
            }
        });
    }
    #[test]
    fn authorization_uses_pkce_plan_scopes_and_issued_clients() {
        let url = authorization_url(
            "host",
            None,
            "http://127.0.0.1:1234/auth/callback",
            "state",
            "nonce",
            "verifier",
        );
        let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["client_id"], "dynamic_agent_client");
        assert_eq!(
            params["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(b"verifier"))
        );
        assert!(params["scope"].contains("chatgpt.tokens.use.direct"));
        let registration = Registration {
            clientId: "issued".into(),
            subject: Some("user".into()),
            email: None,
        };
        let url = authorization_url(
            "host",
            Some(&registration),
            "http://127.0.0.1:1/auth/callback",
            "s",
            "n",
            "v",
        );
        let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["client_id"], "issued");
        assert!(!params.contains_key("agent_name_hint"));
    }
    #[test]
    fn callbacks_reject_mismatched_state_clients_errors_and_duplicate_parameters() {
        let uri = "http://127.0.0.1:1/auth/callback";
        assert!(
            callback_parameters(
                "/auth/callback?state=s&code=c&client_id=issued",
                uri,
                "s",
                None
            )
            .is_ok()
        );
        for target in [
            "/auth/callback?state=wrong&code=c&client_id=issued",
            "/auth/callback?state=s&code=c",
            "/auth/callback?state=s&code=c&client_id=dynamic_agent_client",
            "/auth/callback?state=s&error=access_denied",
            "/auth/callback?state=s&state=s&code=c&client_id=issued",
            "/callback?state=s&code=c&client_id=issued",
        ] {
            assert!(callback_parameters(target, uri, "s", None).is_err());
        }
        let registration = Registration {
            clientId: "issued".into(),
            subject: None,
            email: None,
        };
        assert!(
            callback_parameters(
                "/auth/callback?state=s&code=c",
                uri,
                "s",
                Some(&registration)
            )
            .is_ok()
        );
        assert!(
            callback_parameters(
                "/auth/callback?state=s&code=c&client_id=other",
                uri,
                "s",
                Some(&registration)
            )
            .is_err()
        );
    }
    #[test]
    fn streams_require_completion_and_preserve_plan_limit_failures() {
        assert!(
            parse_event(r#"{"type":"response.output_text.delta","delta":"partial"}"#)
                .unwrap()
                .is_none()
        );
        assert!(
            parse_event(r#"{"type":"response.completed","response":{"status":"completed"}}"#)
                .unwrap()
                .is_some()
        );
        let error = parse_event(r#"{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}"#).err().unwrap();
        assert_eq!(error.code, "rateLimit");
        assert!(parse_event(r#"{"type":"response.incomplete"}"#).is_err());
    }
    #[test]
    fn catalog_uses_chatgpt_contract_and_filters_hidden_models() {
        let models = parse_models(&json!({"models":[{"slug":"visible", "display_name":"Visible", "visibility":"list"},{"slug":"hidden", "visibility":"hidden"}]})).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "visible");
        assert!(!plan_enabled(&["openid".into()]));
    }
}
