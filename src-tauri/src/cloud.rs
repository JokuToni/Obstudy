#![allow(non_snake_case)]
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    token: String,
    userId: String,
    deviceId: String,
    email: String,
    expiresAt: String,
}
fn base_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid API address.")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an HTTPS API base address without credentials or a path.".into());
    }
    Ok(url)
}
fn entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        if cfg!(debug_assertions) {
            "com.obstudy.sync.dev"
        } else {
            "com.obstudy.sync"
        },
        server,
    )
    .map_err(|_| "Unable to access secure account storage.".into())
}
fn credentials(server: &str) -> Result<Option<Credentials>, String> {
    let key = entry(server)?;
    match key.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "Saved login is invalid. Sign in again.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Unable to read your login from secure account storage.".into()),
    }
}
fn public(credentials: &Credentials) -> Value {
    json!({"userId":credentials.userId,"deviceId":credentials.deviceId,"email":credentials.email,"expiresAt":credentials.expiresAt})
}
async fn request(
    server: &str,
    path: &str,
    method: &str,
    body: Value,
    token: Option<&str>,
) -> Result<Value, String> {
    let base = base_url(server)?;
    if !path.starts_with("/v1/")
        || path.starts_with("//")
        || path.contains("..")
        || !matches!(method, "GET" | "POST" | "PUT" | "DELETE")
    {
        return Err("Unsupported API request.".into());
    }
    let url = base.join(path).map_err(|_| "Invalid API request path.")?;
    if url.origin() != base.origin() {
        return Err("API request must stay on the configured server.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Unable to create API connection.")?;
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid API method.")?,
        url,
    );
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if !body.is_null() {
        request = request.json(&body);
    }
    let mut response = request.send().await.map_err(
        |_| "The study server is unreachable. Your local changes are saved; try syncing again.",
    )?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > 32 * 1024 * 1024)
    {
        return Err("The server response is too large.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Unable to read API response.")?
    {
        if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err("The server response is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&bytes)
            .unwrap_or(json!({"error":format!("The server returned HTTP {status}. Try again.")}))
    };
    Ok(json!({"status":status,"body":value}))
}
#[tauri::command]
pub fn cloud_get_session(window: tauri::WebviewWindow, serverUrl: String) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Account access is restricted to the main window.".into());
    }
    let server = base_url(&serverUrl)?.origin().ascii_serialization();
    Ok(credentials(&server)?
        .as_ref()
        .map(public)
        .unwrap_or(Value::Null))
}
#[tauri::command]
pub async fn cloud_sign_in(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    serverUrl: String,
    email: String,
    password: String,
    register: bool,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Account access is restricted to the main window.".into());
    }
    let server = base_url(&serverUrl)?.origin().ascii_serialization();
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Unable to locate device settings.")?;
    std::fs::create_dir_all(&directory).map_err(|_| "Unable to create device settings.")?;
    let path = directory.join("sync-device-id");
    let deviceId = std::fs::read_to_string(&path)
        .ok()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    std::fs::write(path, &deviceId).map_err(|_| "Unable to save device identity.")?;
    let response=request(&server,if register {"/v1/auth/register"} else {"/v1/auth/login"},"POST",json!({"email":email,"password":password,"deviceId":deviceId,"deviceName":if cfg!(mobile) {"Obstudy iPhone"} else {"Obstudy desktop"}}),None).await?;
    if !response["status"]
        .as_u64()
        .is_some_and(|status| (200..300).contains(&status))
    {
        return Err(response["body"]["error"]
            .as_str()
            .unwrap_or("Unable to sign in.")
            .into());
    }
    let mut data = response["body"].clone();
    data["email"] = json!(email);
    let saved: Credentials = serde_json::from_value(data).map_err(|_| "Invalid login response.")?;
    entry(&server)?
        .set_password(&serde_json::to_string(&saved).map_err(|_| "Unable to save login.")?)
        .map_err(|_| "Unable to save your login securely.")?;
    Ok(public(&saved))
}
#[tauri::command]
pub async fn cloud_request(
    window: tauri::WebviewWindow,
    serverUrl: String,
    path: String,
    method: String,
    body: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Account access is restricted to the main window.".into());
    }
    let server = base_url(&serverUrl)?.origin().ascii_serialization();
    let saved = credentials(&server)?.ok_or("Sign in to sync this device.")?;
    request(&server, &path, &method, body, Some(&saved.token)).await
}
#[tauri::command]
pub async fn cloud_sign_out(window: tauri::WebviewWindow, serverUrl: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Account access is restricted to the main window.".into());
    }
    let server = base_url(&serverUrl)?.origin().ascii_serialization();
    if let Some(saved) = credentials(&server)? {
        let _ = request(
            &server,
            "/v1/auth/logout",
            "POST",
            Value::Null,
            Some(&saved.token),
        )
        .await;
    }
    match entry(&server)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Unable to remove saved login.".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_require_https_and_an_unambiguous_origin() {
        assert!(base_url("https://study.example.com").is_ok());
        assert!(base_url("http://127.0.0.1:3000").is_ok());
        for value in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/path",
            "https://example.com?token=secret",
        ] {
            assert!(base_url(value).is_err());
        }
    }
}
