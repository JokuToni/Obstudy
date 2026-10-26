#![allow(non_snake_case)]
use super::{
    AiConfiguration, AiError, AiIntegration, AiProvider, config_store, normalize_configuration,
};
use serde_json::{Value, json};
use sqlx::{Connection, Row, SqliteConnection, migrate::Migrator, sqlite::SqliteConnectOptions};
use std::{path::Path, time::Duration};
use tauri::Manager;

static MIGRATIONS: Migrator = sqlx::migrate!("./ai-migrations");
const OAUTH_CREDENTIAL: &str = "openai-oauth-session";
fn db_error(_: sqlx::Error) -> AiError {
    AiError::new(
        "configuration",
        "Unable to read or save the AI integration database. Check that app storage is available.",
    )
}
async fn open_file(path: &Path) -> Result<SqliteConnection, AiError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(db_error)?;
    MIGRATIONS.run_direct(&mut connection).await.map_err(|_| {
        AiError::new(
            "configuration",
            "Unable to migrate the AI integration database.",
        )
    })?;
    Ok(connection)
}
async fn open(app: &tauri::AppHandle) -> Result<SqliteConnection, AiError> {
    let folder = app.path().app_config_dir().map_err(|_| {
        AiError::new(
            "configuration",
            "Unable to locate app configuration storage.",
        )
    })?;
    std::fs::create_dir_all(&folder).map_err(|_| {
        AiError::new(
            "configuration",
            "Unable to create app configuration storage.",
        )
    })?;
    let mut connection = open_file(&folder.join(if cfg!(debug_assertions) {
        "integrations.dev.db"
    } else {
        "integrations.db"
    }))
    .await?;
    let imported: bool =
        sqlx::query_scalar("SELECT legacyImported FROM aiPreferences WHERE id = 1")
            .fetch_one(&mut connection)
            .await
            .map_err(db_error)?;
    if !imported {
        let store = config_store(app)?;
        import_legacy(
            &mut connection,
            store.get("configuration"),
            store.get("oauthRegistration"),
            store.get("oauthHostId"),
        )
        .await?;
    }
    Ok(connection)
}
async fn import_legacy(
    connection: &mut SqliteConnection,
    config: Option<Value>,
    registration: Option<Value>,
    hostId: Option<Value>,
) -> Result<(), AiError> {
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(db_error)?;
    let imported: bool =
        sqlx::query_scalar("SELECT legacyImported FROM aiPreferences WHERE id = 1")
            .fetch_one(&mut *transaction)
            .await
            .map_err(db_error)?;
    if !imported {
        let config = config
            .map(serde_json::from_value::<AiConfiguration>)
            .transpose()
            .map_err(|_| {
                AiError::new(
                    "configuration",
                    "Existing AI settings could not be migrated. Their original file was retained.",
                )
            })?
            .unwrap_or_default();
        write_configuration(&mut transaction, &normalize_configuration(config)).await?;
        if let Some(registration) = registration {
            write_value(&mut transaction, "oauthRegistration", &registration).await?;
        }
        if let Some(hostId) = hostId {
            write_value(&mut transaction, "oauthHostId", &hostId).await?;
        }
        sqlx::query("UPDATE aiPreferences SET legacyImported = 1 WHERE id = 1")
            .execute(&mut *transaction)
            .await
            .map_err(db_error)?;
    }
    transaction.commit().await.map_err(db_error)
}
async fn read_configuration(connection: &mut SqliteConnection) -> Result<AiConfiguration, AiError> {
    let rows = sqlx::query("SELECT id, provider, model, maxOutputTokens, reasoningEffort FROM aiIntegrations ORDER BY rowid").fetch_all(&mut *connection).await.map_err(db_error)?;
    let mut integrations = Vec::new();
    for row in rows {
        integrations.push(serde_json::from_value::<AiIntegration>(json!({"id":row.get::<String,_>("id"),"provider":row.get::<String,_>("provider"),"model":row.get::<String,_>("model"),"maxOutputTokens":row.get::<i64,_>("maxOutputTokens"),"reasoningEffort":row.get::<Option<String>,_>("reasoningEffort")})).map_err(|_| AiError::new("configuration", "Saved AI integration data is invalid."))?);
    }
    let activeIntegrationId =
        sqlx::query_scalar("SELECT activeIntegrationId FROM aiPreferences WHERE id = 1")
            .fetch_one(connection)
            .await
            .map_err(db_error)?;
    Ok(AiConfiguration {
        integrations,
        activeIntegrationId,
    })
}
async fn write_configuration(
    connection: &mut SqliteConnection,
    config: &AiConfiguration,
) -> Result<(), AiError> {
    // The caller owns a transaction so selection and rows always commit together.
    sqlx::query("UPDATE aiPreferences SET activeIntegrationId = NULL WHERE id = 1")
        .execute(&mut *connection)
        .await
        .map_err(db_error)?;
    sqlx::query("DELETE FROM aiIntegrations")
        .execute(&mut *connection)
        .await
        .map_err(db_error)?;
    for integration in &config.integrations {
        let provider = serde_json::to_value(integration.provider).unwrap();
        sqlx::query("INSERT INTO aiIntegrations (id, provider, model, maxOutputTokens, reasoningEffort, credentialReference) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&integration.id).bind(provider.as_str().unwrap()).bind(&integration.model).bind(i64::from(integration.maxOutputTokens)).bind(&integration.reasoningEffort)
            .bind(if integration.provider == AiProvider::OpenaiOauth { OAUTH_CREDENTIAL } else { &integration.id }).execute(&mut *connection).await.map_err(db_error)?;
    }
    sqlx::query("UPDATE aiPreferences SET activeIntegrationId = ? WHERE id = 1")
        .bind(&config.activeIntegrationId)
        .execute(connection)
        .await
        .map_err(db_error)?;
    Ok(())
}
pub async fn read_config(app: &tauri::AppHandle) -> Result<AiConfiguration, AiError> {
    let mut connection = open(app).await?;
    // One snapshot avoids mixing an old selection with concurrently changed rows.
    let mut transaction = connection.begin().await.map_err(db_error)?;
    let config = read_configuration(&mut transaction).await?;
    transaction.commit().await.map_err(db_error)?;
    connection.close().await.map_err(db_error)?;
    Ok(config)
}
pub async fn write_config(app: &tauri::AppHandle, config: &AiConfiguration) -> Result<(), AiError> {
    let mut connection = open(app).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(db_error)?;
    write_configuration(&mut transaction, config).await?;
    transaction.commit().await.map_err(db_error)?;
    connection.close().await.map_err(db_error)
}
pub async fn read_json(app: &tauri::AppHandle, key: &str) -> Result<Option<Value>, AiError> {
    let mut connection = open(app).await?;
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM aiSettings WHERE key = ?")
        .bind(key)
        .fetch_optional(&mut connection)
        .await
        .map_err(db_error)?;
    connection.close().await.map_err(db_error)?;
    value
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(|_| AiError::new("configuration", "Saved AI settings are invalid."))
}
async fn write_value(
    connection: &mut SqliteConnection,
    key: &str,
    value: &Value,
) -> Result<(), AiError> {
    sqlx::query("INSERT INTO aiSettings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key).bind(value.to_string()).execute(&mut *connection).await.map_err(db_error)?;
    if key == "oauthRegistration" {
        let clientId = value["clientId"].as_str().ok_or_else(|| {
            AiError::new("configuration", "The OAuth registration has no client ID.")
        })?;
        sqlx::query("INSERT INTO aiOAuthAccounts (clientId, issuer, subject, email, credentialReference) VALUES (?, 'https://auth.openai.com', ?, ?, ?) ON CONFLICT(clientId) DO UPDATE SET subject = excluded.subject, email = excluded.email")
            .bind(clientId).bind(value["subject"].as_str()).bind(value["email"].as_str()).bind(OAUTH_CREDENTIAL).execute(connection).await.map_err(db_error)?;
    }
    Ok(())
}
pub async fn write_json(app: &tauri::AppHandle, key: &str, value: &Value) -> Result<(), AiError> {
    let mut connection = open(app).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(db_error)?;
    write_value(&mut transaction, key, value).await?;
    transaction.commit().await.map_err(db_error)?;
    connection.close().await.map_err(db_error)
}
pub async fn record_session(
    app: &tauri::AppHandle,
    registration: &Value,
    scopes: &[String],
    expiresAt: u64,
) -> Result<(), AiError> {
    let mut connection = open(app).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(db_error)?;
    write_value(&mut transaction, "oauthRegistration", registration).await?;
    sqlx::query(
        "UPDATE aiOAuthAccounts SET scopes = ?, expiresAt = ?, connected = 1 WHERE clientId = ?",
    )
    .bind(json!(scopes).to_string())
    .bind(expiresAt.min(i64::MAX as u64) as i64)
    .bind(registration["clientId"].as_str())
    .execute(&mut *transaction)
    .await
    .map_err(db_error)?;
    transaction.commit().await.map_err(db_error)?;
    connection.close().await.map_err(db_error)
}
pub async fn record_sign_out(app: &tauri::AppHandle) -> Result<(), AiError> {
    let mut connection = open(app).await?;
    sqlx::query("UPDATE aiOAuthAccounts SET connected = 0, scopes = '[]', expiresAt = NULL")
        .execute(&mut connection)
        .await
        .map_err(db_error)?;
    connection.close().await.map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oauth_selection_and_metadata_survive_restart_and_failed_updates_roll_back() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir()
                .join(format!("obstudy-ai-restart-{}.db", uuid::Uuid::new_v4()));
            let mut connection = open_file(&path).await.unwrap();
            import_legacy(&mut connection, None, None, None)
                .await
                .unwrap();
            let config: AiConfiguration = serde_json::from_value(json!({
                "integrations": [
                    {"id":"openai", "provider":"openai", "model":"gpt-6-sol", "maxOutputTokens":1024},
                    {"id":"anthropic", "provider":"anthropic", "model":"claude-opus-5-5", "maxOutputTokens":2048},
                    {"id":"openaiOauth", "provider":"openaiOauth", "model":"gpt-6.1-sol", "maxOutputTokens":4096,"reasoningEffort":"high"}
                ], "activeIntegrationId":"openaiOauth"
            })).unwrap();
            let mut transaction = connection.begin().await.unwrap();
            write_configuration(&mut transaction, &config)
                .await
                .unwrap();
            write_value(
                &mut transaction,
                "oauthRegistration",
                &json!({"clientId":"issued", "subject":"test-subject", "email":"test@example.com"}),
            )
            .await
            .unwrap();
            write_value(
                &mut transaction,
                "oauthHostId",
                &json!("host-before-restart"),
            )
            .await
            .unwrap();
            transaction.commit().await.unwrap();
            connection.close().await.unwrap();

            let mut connection = open_file(&path).await.unwrap();
            let restored = read_configuration(&mut connection).await.unwrap();
            assert_eq!(restored.integrations.len(), 3);
            assert_eq!(restored.activeIntegrationId.as_deref(), Some("openaiOauth"));
            assert_eq!(restored.integrations[2].model, "gpt-6.1-sol");
            assert_eq!(
                restored.integrations[2].reasoningEffort.as_deref(),
                Some("high")
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT credentialReference FROM aiIntegrations WHERE provider = 'openaiOauth'"
                )
                .fetch_one(&mut connection)
                .await
                .unwrap(),
                OAUTH_CREDENTIAL
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM aiSettings WHERE key = 'oauthHostId'"
                )
                .fetch_one(&mut connection)
                .await
                .unwrap(),
                "\"host-before-restart\""
            );
            let mut invalid = restored;
            invalid.integrations.push(invalid.integrations[0].clone());
            let mut transaction = connection.begin().await.unwrap();
            assert!(
                write_configuration(&mut transaction, &invalid)
                    .await
                    .is_err()
            );
            transaction.rollback().await.unwrap();
            assert_eq!(
                read_configuration(&mut connection)
                    .await
                    .unwrap()
                    .integrations
                    .len(),
                3
            );
            connection.close().await.unwrap();
            std::fs::remove_file(path).unwrap();
        });
    }
    #[test]
    fn database_survives_reopen_and_legacy_import_does_not_resurrect_removed_integrations() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir().join(format!("obstudy-ai-{}.db", uuid::Uuid::new_v4()));
            let legacy = json!({"integrations":[{"id":"openai", "provider":"openai", "model":"gpt-6.1-sol", "maxOutputTokens":4096, "reasoningEffort":"high"}],"activeIntegrationId":"openai"});
            let registration =
                json!({"clientId":"issued", "subject":"test-subject", "email":"test@example.com"});
            let mut connection = open_file(&path).await.unwrap();
            import_legacy(
                &mut connection,
                Some(legacy.clone()),
                Some(registration.clone()),
                Some(json!("stable-host")),
            )
            .await
            .unwrap();
            connection.close().await.unwrap();
            let mut connection = open_file(&path).await.unwrap();
            let config = read_configuration(&mut connection).await.unwrap();
            assert_eq!(config.integrations.len(), 1);
            assert_eq!(config.activeIntegrationId.as_deref(), Some("openai"));
            assert_eq!(
                config.integrations[0].reasoningEffort.as_deref(),
                Some("high")
            );
            let columns: Vec<String> =
                sqlx::query_scalar("SELECT name FROM pragma_table_info('aiOAuthAccounts')")
                    .fetch_all(&mut connection)
                    .await
                    .unwrap();
            assert!(
                !columns
                    .iter()
                    .any(|column| column.to_lowercase().contains("token"))
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT credentialReference FROM aiIntegrations")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap(),
                "openai"
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT clientId FROM aiOAuthAccounts")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap(),
                "issued"
            );
            let mut transaction = connection.begin().await.unwrap();
            write_configuration(&mut transaction, &AiConfiguration::default())
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            import_legacy(&mut connection, Some(legacy), Some(registration), None)
                .await
                .unwrap();
            assert!(
                read_configuration(&mut connection)
                    .await
                    .unwrap()
                    .integrations
                    .is_empty()
            );
            assert!(
                sqlx::query(
                    "INSERT INTO aiIntegrations VALUES ('bad', 'unknown', '', 1, NULL, 'bad')"
                )
                .execute(&mut connection)
                .await
                .is_err()
            );
            connection.close().await.unwrap();
            std::fs::remove_file(path).unwrap();
        });
    }
}
