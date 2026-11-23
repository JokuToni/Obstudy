#![allow(non_snake_case)]

use serde_json::{Value, json};
use sqlx::{Connection, Row, SqliteConnection, migrate::Migrator, sqlite::SqliteConnectOptions};
use std::{path::Path, time::Duration};
#[cfg(mobile)]
use tauri::Manager;

static MIGRATIONS: Migrator = sqlx::migrate!("./mobile-migrations");
#[cfg(mobile)]
#[derive(Default)]
pub struct MobileStorage(tokio::sync::Mutex<()>);

async fn open(path: &Path) -> Result<SqliteConnection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Unable to create mobile app storage.")?;
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open mobile storage: {error}"))?;
    MIGRATIONS
        .run_direct(&mut connection)
        .await
        .map_err(|error| format!("Unable to update mobile storage: {error}"))?;
    Ok(connection)
}
async fn load(path: &Path) -> Result<Value, String> {
    let mut connection = open(path).await?;
    let row = sqlx::query("SELECT revision, document FROM mobileState WHERE id=1")
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| error.to_string())?;
    match row {
        Some(row) => Ok(json!({
            "revision": row.get::<i64, _>("revision"),
            "state": serde_json::from_str::<Value>(&row.get::<String, _>("document")).map_err(|_| "Stored study data is invalid.")?
        })),
        None => Ok(json!({"revision": 0, "state": null})),
    }
}
async fn save(path: &Path, expectedRevision: i64, state: Value) -> Result<i64, String> {
    if state["schemaVersion"] != 1
        || state["deviceId"].as_str().is_none_or(str::is_empty)
        || expectedRevision < 0
    {
        return Err("Unsupported mobile study data.".into());
    }
    let document = state.to_string();
    let mut connection = open(path).await?;
    let changed = if expectedRevision == 0 {
        sqlx::query("INSERT OR IGNORE INTO mobileState(id,revision,document) VALUES (1,1,?)")
            .bind(document)
            .execute(&mut connection)
            .await
    } else {
        sqlx::query(
            "UPDATE mobileState SET revision=revision+1,document=? WHERE id=1 AND revision=?",
        )
        .bind(document)
        .bind(expectedRevision)
        .execute(&mut connection)
        .await
    }
    .map_err(|error| format!("Unable to save mobile study data: {error}"))?;
    if changed.rows_affected() != 1 {
        return Err("Study data changed elsewhere. Reload before continuing.".into());
    }
    Ok(expectedRevision + 1)
}
#[cfg(mobile)]
fn storagePath(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("mobile").join("study.db"))
        .map_err(|_| "Unable to locate mobile app storage.".into())
}
#[cfg(mobile)]
#[tauri::command]
pub async fn mobile_load_state(
    app: tauri::AppHandle,
    storage: tauri::State<'_, MobileStorage>,
) -> Result<Value, String> {
    let _guard = storage.0.lock().await;
    load(&storagePath(&app)?).await
}
#[cfg(mobile)]
#[tauri::command]
pub async fn mobile_save_state(
    app: tauri::AppHandle,
    storage: tauri::State<'_, MobileStorage>,
    expectedRevision: i64,
    state: Value,
) -> Result<i64, String> {
    let _guard = storage.0.lock().await;
    save(&storagePath(&app)?, expectedRevision, state).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mobile_storage_is_durable_and_rejects_stale_writes() {
        tauri::async_runtime::block_on(async {
            let path =
                std::env::temp_dir().join(format!("obstudy-mobile-{}.db", uuid::Uuid::new_v4()));
            assert_eq!(
                load(&path).await.unwrap(),
                json!({"revision":0,"state":null})
            );
            let state = json!({"schemaVersion":1,"deviceId":"test-device","outbox":[{"id":"answer-event"}]});
            assert_eq!(save(&path, 0, state.clone()).await.unwrap(), 1);
            assert_eq!(load(&path).await.unwrap()["state"], state);
            assert!(
                save(&path, 0, json!({"schemaVersion":1,"deviceId":"other"}))
                    .await
                    .is_err()
            );
            assert!(save(&path, 2, state.clone()).await.is_err());
            assert_eq!(load(&path).await.unwrap()["revision"], 1);
            assert_eq!(save(&path, 1, state).await.unwrap(), 2);
            assert!(save(&path, 2, json!({"schemaVersion":2})).await.is_err());
            std::fs::remove_file(path).unwrap();
        });
    }
}
