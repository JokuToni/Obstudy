#![allow(non_snake_case)]
mod capabilities;
pub mod oauth;
mod providers;
mod storage;

use reqwest::{Client, header::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_store::StoreExt;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Openai,
    Anthropic,
    #[serde(rename = "openaiOauth")]
    OpenaiOauth,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AiIntegration {
    id: String,
    provider: AiProvider,
    model: String,
    maxOutputTokens: u32,
    #[serde(default)]
    reasoningEffort: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct AiConfiguration {
    integrations: Vec<AiIntegration>,
    activeIntegrationId: Option<String>,
}

#[derive(Clone, Default, Serialize)]
pub struct AiRateLimits {
    headers: HashMap<String, String>,
    observedAt: u64,
}

#[derive(Clone, Serialize)]
pub struct AiTokenUsage {
    inputTokens: u64,
    outputTokens: u64,
    totalTokens: u64,
    cacheReadInputTokens: u64,
    cacheCreationInputTokens: u64,
}

#[derive(Clone, Serialize)]
pub struct AiResponse {
    text: String,
    integrationId: String,
    provider: AiProvider,
    model: String,
    responseId: Option<String>,
    usage: AiTokenUsage,
    rateLimits: AiRateLimits,
}

#[derive(Debug, Serialize)]
pub struct AiError {
    code: String,
    message: String,
    status: Option<u16>,
    rateLimits: Option<AiRateLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    providerCode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requestId: Option<String>,
}

impl std::fmt::Debug for AiRateLimits {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiRateLimits")
            .field("headers", &self.headers)
            .finish()
    }
}

impl AiError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
            rateLimits: None,
            providerCode: None,
            requestId: None,
        }
    }
}

pub struct AiState {
    client: Client,
    oauth: oauth::OauthState,
    modelCatalogs: Mutex<HashMap<AiProvider, Vec<AiModel>>>,
    lastResponses: Mutex<HashMap<String, AiResponse>>,
    configurationLock: tokio::sync::Mutex<()>,
}
impl Default for AiState {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(120))
                .connect_timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Unable to create AI HTTP client"),
            oauth: Default::default(),
            modelCatalogs: Mutex::new(HashMap::new()),
            lastResponses: Mutex::new(HashMap::new()),
            configurationLock: tokio::sync::Mutex::new(()),
        }
    }
}

fn config_store(
    app: &tauri::AppHandle,
) -> Result<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>, AiError> {
    app.store(if cfg!(debug_assertions) {
        "ai.dev.json"
    } else {
        "ai.json"
    })
    .map_err(|_| AiError::new("configuration", "Unable to open AI settings."))
}
async fn read_config(app: &tauri::AppHandle) -> Result<AiConfiguration, AiError> {
    storage::read_config(app).await
}
async fn write_config(app: &tauri::AppHandle, config: &AiConfiguration) -> Result<(), AiError> {
    storage::write_config(app, config).await
}
fn validate_id(id: &str) -> Result<(), AiError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AiError::new(
            "configuration",
            "Integration IDs must contain 1–128 letters, digits, underscores or hyphens.",
        ));
    }
    Ok(())
}
fn credential(app: &tauri::AppHandle, id: &str) -> Result<keyring::Entry, AiError> {
    validate_id(id)?;
    let service = format!(
        "{}.ai{}",
        app.config().identifier,
        if cfg!(debug_assertions) { ".dev" } else { "" }
    );
    keyring::Entry::new(&service, id).map_err(|_| {
        AiError::new(
            "credentials",
            "The operating system credential store is unavailable.",
        )
    })
}
fn read_key(app: &tauri::AppHandle, id: &str) -> Result<String, AiError> {
    credential(app, id)?.get_password().map_err(|_| {
        AiError::new(
            "credentials",
            "Add an API key for this integration or unlock the operating system credential store.",
        )
    })
}
async fn find_integration(app: &tauri::AppHandle, id: &str) -> Result<AiIntegration, AiError> {
    read_config(app)
        .await?
        .integrations
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AiError::new("configuration", "The AI integration does not exist."))
}

#[tauri::command]
pub async fn get_ai_configuration(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
) -> Result<AiConfiguration, AiError> {
    let _guard = state.configurationLock.lock().await;
    let mut config = read_config(&app).await?;
    if !config
        .integrations
        .iter()
        .any(|item| item.provider == AiProvider::OpenaiOauth)
    {
        if let Some(mut integration) = oauth::restored_integration(app.clone()).await? {
            if config
                .integrations
                .iter()
                .any(|item| item.id == integration.id)
            {
                integration.id = format!("openaiOauth-{}", uuid::Uuid::new_v4());
            }
            if config.activeIntegrationId.is_none() {
                config.activeIntegrationId = Some(integration.id.clone());
            }
            config.integrations.push(integration);
            write_config(&app, &config).await?;
        }
    }
    Ok(config)
}

async fn save_ai_integration_inner(
    app: tauri::AppHandle,
    state: Arc<AiState>,
    integration: AiIntegration,
    apiKey: Option<String>,
) -> Result<(), AiError> {
    validate_id(&integration.id)?;
    capabilities::validate_effort(&state, &integration)?;
    if integration.model.trim().is_empty() || integration.maxOutputTokens == 0 {
        return Err(AiError::new(
            "configuration",
            "A model ID and positive output token limit are required.",
        ));
    }
    let _guard = state.configurationLock.lock().await;
    let mut config = read_config(&app).await?;
    validate_provider_uniqueness(&config, &integration)?;
    if integration.provider == AiProvider::OpenaiOauth {
        if apiKey.is_some() {
            return Err(AiError::new(
                "configuration",
                "ChatGPT sign-in does not accept API keys.",
            ));
        }
    } else if let Some(key) = apiKey {
        if key.trim().is_empty() {
            return Err(AiError::new("credentials", "The API key cannot be empty."));
        }
        let key = key.trim().to_owned();
        let keyApp = app.clone();
        let keyId = integration.id.clone();
        blocking(move || {
            credential(&keyApp, &keyId)?
                .set_password(&key)
                .map_err(|_| {
                    AiError::new(
                        "credentials",
                        "Unable to save the API key in the system credential store.",
                    )
                })
        })
        .await?;
    } else {
        load_key(app.clone(), integration.id.clone()).await?;
    }
    config.integrations.retain(|item| item.id != integration.id);
    if config.activeIntegrationId.is_none() {
        config.activeIntegrationId = Some(integration.id.clone());
    }
    config.integrations.push(integration);
    write_config(&app, &config).await
}

#[tauri::command]
pub async fn select_ai_integration(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
    integrationId: String,
) -> Result<(), AiError> {
    let _guard = state.configurationLock.lock().await;
    find_integration(&app, &integrationId).await?;
    let mut config = read_config(&app).await?;
    config.activeIntegrationId = Some(integrationId);
    write_config(&app, &config).await
}

async fn remove_ai_integration_inner(
    app: tauri::AppHandle,
    state: Arc<AiState>,
    integrationId: String,
) -> Result<(), AiError> {
    let _guard = state.configurationLock.lock().await;
    let mut config = read_config(&app).await?;
    find_integration(&app, &integrationId).await?;
    let keyApp = app.clone();
    let keyId = integrationId.clone();
    blocking(
        move || match credential(&keyApp, &keyId)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AiError::new(
                "credentials",
                "Unable to remove the saved API key.",
            )),
        },
    )
    .await?;
    config.integrations.retain(|item| item.id != integrationId);
    if config.activeIntegrationId.as_deref() == Some(&integrationId) {
        config.activeIntegrationId = None;
    }
    state
        .lastResponses
        .lock()
        .map_err(|_| AiError::new("configuration", "Unable to clear usage."))?
        .remove(&integrationId);
    write_config(&app, &config).await
}

fn rate_limits(headers: &HeaderMap) -> AiRateLimits {
    AiRateLimits {
        observedAt: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        headers: headers
            .iter()
            .filter(|(name, _)| {
                name.as_str().starts_with("x-ratelimit-")
                    || name.as_str().starts_with("anthropic-ratelimit-")
                    || name.as_str() == "retry-after"
            })
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|text| (name.as_str().into(), text.into()))
            })
            .collect(),
    }
}
async fn read_http(response: reqwest::Response) -> Result<(Value, AiRateLimits), AiError> {
    let status = response.status();
    let limits = rate_limits(response.headers());
    if !status.is_success() {
        let (code, message) = match status.as_u16() {
            401 | 403 => (
                "authentication",
                "API authentication failed. Check your key and account permissions.",
            ),
            429 => (
                "rateLimit",
                "The provider rejected the request because of a rate or account limit. Check retry-after and your provider dashboard.",
            ),
            _ => (
                "provider",
                "The provider rejected the request. Check model availability, output limits and service status.",
            ),
        };
        return Err(AiError {
            code: code.into(),
            message: message.into(),
            status: Some(status.as_u16()),
            rateLimits: Some(limits),
            providerCode: None,
            requestId: None,
        });
    }
    let body = response.json().await.map_err(|_| {
        AiError::new(
            "invalidResponse",
            "The provider returned an invalid JSON response.",
        )
    })?;
    Ok((body, limits))
}

#[tauri::command]
pub async fn prompt_ai(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
    prompt: String,
) -> Result<AiResponse, AiError> {
    if prompt.trim().is_empty() {
        return Err(AiError::new("configuration", "The prompt cannot be empty."));
    }
    let config = read_config(&app).await?;
    let id = config
        .activeIntegrationId
        .ok_or_else(|| AiError::new("configuration", "Select an AI integration first."))?;
    let integration = find_integration(&app, &id).await?;
    if integration.model.trim().is_empty() {
        return Err(AiError::new(
            "configuration",
            "Your login is saved. Choose a model in AI integrations before sending prompts.",
        ));
    }
    let result = if integration.provider == AiProvider::OpenaiOauth {
        oauth::prompt(&app, &state, &integration, &prompt).await?
    } else {
        let key = load_key(app.clone(), id.clone()).await?;
        let response = integration
            .provider
            .prompt_request(&state.client, &key, &integration, &prompt)
            .send()
            .await
            .map_err(|_| {
                AiError::new(
                    "network",
                    "The AI request failed or timed out. Check your connection before retrying.",
                )
            })?;
        let (body, limits) = read_http(response).await?;
        let mut result = providers::parse_response(&integration, &body).map_err(|mut error| {
            error.rateLimits = Some(limits.clone());
            error
        })?;
        result.rateLimits = limits;
        result
    };
    state
        .lastResponses
        .lock()
        .map_err(|_| AiError::new("configuration", "Unable to track usage."))?
        .insert(id, result.clone());
    Ok(result)
}

#[tauri::command]
pub fn get_last_ai_response(
    state: tauri::State<'_, Arc<AiState>>,
    integrationId: String,
) -> Result<Option<AiResponse>, AiError> {
    Ok(state
        .lastResponses
        .lock()
        .map_err(|_| AiError::new("configuration", "Unable to read usage."))?
        .get(&integrationId)
        .cloned())
}

#[derive(Clone, Serialize)]
pub struct AiModel {
    id: String,
    name: String,
    effortLevels: Vec<String>,
}

#[tauri::command]
pub async fn list_ai_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
    integrationId: String,
) -> Result<Vec<AiModel>, AiError> {
    let integration = find_integration(&app, &integrationId).await?;
    if integration.provider == AiProvider::OpenaiOauth {
        return oauth::list_openai_oauth_models(app, state).await;
    }
    let key = load_key(app.clone(), integrationId.clone()).await?;
    let models = fetch_models(&state.client, &integration.provider, &key).await?;
    capabilities::cache_models(&state, integration.provider, &models)?;
    Ok(models)
}

#[tauri::command]
pub async fn discover_ai_models(
    state: tauri::State<'_, Arc<AiState>>,
    provider: AiProvider,
    apiKey: String,
) -> Result<Vec<AiModel>, AiError> {
    if provider == AiProvider::OpenaiOauth {
        return Err(AiError::new(
            "configuration",
            "Use ChatGPT sign-in to discover its models.",
        ));
    }
    if apiKey.trim().is_empty() {
        return Err(AiError::new(
            "credentials",
            "Enter an API key to discover available models.",
        ));
    }
    let models = fetch_models(&state.client, &provider, apiKey.trim()).await?;
    capabilities::cache_models(&state, provider, &models)?;
    Ok(models)
}

async fn fetch_models(
    client: &Client,
    provider: &AiProvider,
    key: &str,
) -> Result<Vec<AiModel>, AiError> {
    let mut models = Vec::new();
    let mut cursor = None;
    loop {
        let mut request = provider.request(client, key, reqwest::Method::GET, "models");
        if let AiProvider::Anthropic = provider {
            request = request.query(&[("limit", "1000")]);
            if let Some(ref id) = cursor {
                request = request.query(&[("after_id", id)]);
            }
        }
        let response = request
            .send()
            .await
            .map_err(|_| AiError::new("network", "Unable to fetch the model list."))?;
        let (body, _) = read_http(response).await?;
        let data = body["data"].as_array().ok_or_else(|| {
            AiError::new(
                "invalidResponse",
                "The provider returned an invalid model list.",
            )
        })?;
        for model in data {
            if let Some(id) = model["id"].as_str() {
                models.push(AiModel {
                    id: id.into(),
                    name: model["display_name"].as_str().unwrap_or(id).into(),
                    effortLevels: capabilities::effort_levels(*provider, id, model),
                });
            }
        }
        if matches!(provider, AiProvider::Anthropic) && body["has_more"] == true {
            let next = body["last_id"]
                .as_str()
                .ok_or_else(|| {
                    AiError::new(
                        "invalidResponse",
                        "The model list has an invalid pagination cursor.",
                    )
                })?
                .to_owned();
            if cursor.as_ref() == Some(&next) {
                return Err(AiError::new(
                    "invalidResponse",
                    "The model list pagination did not advance.",
                ));
            }
            cursor = Some(next);
        } else {
            break;
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_integration_per_provider_is_enforced() {
        let config: AiConfiguration = serde_json::from_value(json!({
            "integrations": [{"id": "old-openai", "name": "Legacy name", "provider": "openai", "model": "model", "maxOutputTokens": 100}],
            "activeIntegrationId": "old-openai"
        })).unwrap();
        let mut integration = config.integrations[0].clone();
        assert!(validate_provider_uniqueness(&config, &integration).is_ok());
        integration.id = "new-openai".into();
        assert!(validate_provider_uniqueness(&config, &integration).is_err());
        integration.provider = AiProvider::Anthropic;
        assert!(validate_provider_uniqueness(&config, &integration).is_ok());
        integration.id = "old-openai".into();
        assert!(validate_provider_uniqueness(&config, &integration).is_err());
        assert!(
            serde_json::to_value(&config).unwrap()["integrations"][0]
                .get("name")
                .is_none()
        );
    }

    #[test]
    fn legacy_duplicates_retain_the_active_credential_reference() {
        let config: AiConfiguration = serde_json::from_value(json!({
            "integrations": [
                {"id": "first", "name": "Old", "provider": "openai", "model": "model", "maxOutputTokens": 100},
                {"id": "active", "name": "New", "provider": "openai", "model": "model", "maxOutputTokens": 100},
                {"id": "claude", "provider": "anthropic", "model": "model", "maxOutputTokens": 100}
            ], "activeIntegrationId": "active"
        })).unwrap();
        let normalized = normalize_configuration(config);
        assert_eq!(normalized.integrations.len(), 2);
        assert_eq!(normalized.integrations[0].id, "active");
        assert_eq!(normalized.activeIntegrationId.as_deref(), Some("active"));
    }

    #[test]
    fn quota_headers_do_not_include_credentials() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "secret".parse().unwrap());
        headers.insert("x-ratelimit-remaining-tokens", "100".parse().unwrap());
        headers.insert("retry-after", "30".parse().unwrap());
        let limits = rate_limits(&headers);
        assert_eq!(limits.headers.len(), 2);
        assert_eq!(limits.headers["retry-after"], "30");
        assert!(limits.observedAt > 0);
    }
    #[test]
    fn http_failures_preserve_rate_limits_without_exposing_provider_bodies() {
        tauri::async_runtime::block_on(async {
            let response: reqwest::Response = tauri::http::Response::builder()
                .status(429)
                .header("retry-after", "12")
                .body("sensitive provider error body")
                .unwrap()
                .into();
            let error = read_http(response).await.err().unwrap();
            assert_eq!(error.code, "rateLimit");
            assert_eq!(error.status, Some(429));
            assert_eq!(error.rateLimits.unwrap().headers["retry-after"], "12");
            assert!(!error.message.contains("sensitive"));
            let response: reqwest::Response = tauri::http::Response::builder()
                .status(401)
                .body("")
                .unwrap()
                .into();
            assert_eq!(
                read_http(response).await.err().unwrap().code,
                "authentication"
            );
        });
    }

    #[test]
    fn invalid_provider_and_integration_ids_are_rejected() {
        assert!(validate_id("valid-id_1").is_ok());
        assert!(validate_id("../invalid").is_err());
        assert!(validate_id("").is_err());
        assert!(serde_json::from_value::<AiIntegration>(json!({"id": "x", "provider": "unknown", "name": "Name", "model": "model", "maxOutputTokens": 100})).is_err());
    }
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, AiError> + Send + 'static,
) -> Result<T, AiError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| AiError::new("credentials", "The credential operation failed."))?
}

async fn load_key(app: tauri::AppHandle, id: String) -> Result<String, AiError> {
    blocking(move || read_key(&app, &id)).await
}

#[tauri::command]
pub async fn save_ai_integration(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
    integration: AiIntegration,
    apiKey: Option<String>,
) -> Result<(), AiError> {
    if integration.provider == AiProvider::OpenaiOauth {
        oauth::require_plan(app.clone()).await?;
    }
    let state = Arc::clone(state.inner());
    save_ai_integration_inner(app, state, integration, apiKey).await
}

#[tauri::command]
pub async fn remove_ai_integration(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AiState>>,
    integrationId: String,
) -> Result<Option<bool>, AiError> {
    let integration = find_integration(&app, &integrationId).await?;
    let revoked = if integration.provider == AiProvider::OpenaiOauth {
        Some(oauth::disconnect_openai_oauth(app.clone(), state.clone()).await?)
    } else {
        None
    };
    let state = Arc::clone(state.inner());
    remove_ai_integration_inner(app, state, integrationId).await?;
    Ok(revoked)
}

// Older configurations could contain multiple named entries for one provider.
// Prefer the active entry, retain its ID/Keychain reference, and never delete credentials here.
fn normalize_configuration(mut config: AiConfiguration) -> AiConfiguration {
    config.integrations.sort_by_key(|item| {
        if config.activeIntegrationId.as_deref() == Some(&item.id) {
            0
        } else {
            1
        }
    });
    let mut seen = HashSet::new();
    config
        .integrations
        .retain(|item| seen.insert(item.provider));
    if !config
        .integrations
        .iter()
        .any(|item| Some(&item.id) == config.activeIntegrationId.as_ref())
    {
        config.activeIntegrationId = None;
    }
    config
}

fn validate_provider_uniqueness(
    config: &AiConfiguration,
    integration: &AiIntegration,
) -> Result<(), AiError> {
    if config
        .integrations
        .iter()
        .any(|item| item.provider == integration.provider && item.id != integration.id)
    {
        return Err(AiError::new(
            "configuration",
            "This provider is already connected. Edit its existing integration instead.",
        ));
    }
    if config
        .integrations
        .iter()
        .any(|item| item.id == integration.id && item.provider != integration.provider)
    {
        return Err(AiError::new(
            "configuration",
            "An existing integration cannot change providers.",
        ));
    }
    Ok(())
}

async fn remember_oauth_login(app: &tauri::AppHandle, state: &AiState) -> Result<(), AiError> {
    let _guard = state.configurationLock.lock().await;
    let mut config = read_config(app).await?;
    let id = if let Some(existing) = config
        .integrations
        .iter()
        .find(|item| item.provider == AiProvider::OpenaiOauth)
    {
        existing.id.clone()
    } else {
        let mut integration = oauth::restored_integration(app.clone())
            .await?
            .ok_or_else(|| {
                AiError::new("authentication", "ChatGPT plan usage was not authorized.")
            })?;
        if config
            .integrations
            .iter()
            .any(|item| item.id == integration.id)
        {
            integration.id = format!("openaiOauth-{}", uuid::Uuid::new_v4());
        }
        let id = integration.id.clone();
        config.integrations.push(integration);
        id
    };
    config.activeIntegrationId = Some(id);
    write_config(app, &config).await
}
