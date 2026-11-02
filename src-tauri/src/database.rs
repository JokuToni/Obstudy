#![allow(non_snake_case)]

use serde::Serialize;
use sqlx::{Connection, SqliteConnection, migrate::Migrator, sqlite::SqliteConnectOptions};
use std::{path::Path, time::Duration};

static MIGRATIONS: Migrator = sqlx::migrate!("./migrations");
const DATABASE_FILE_NAME: &str = "obstudy.db";

#[derive(Serialize)]
pub struct DatabaseInfo {
    databasePath: String,
    schemaVersion: i64,
}

async fn createDatabaseTables(connection: &mut SqliteConnection) -> Result<i64, String> {
    MIGRATIONS
        .run_direct(&mut *connection)
        .await
        .map_err(|error| format!("Unable to migrate the database: {error}"))?;

    sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1")
        .fetch_one(connection)
        .await
        .map_err(|error| format!("Unable to read the database version: {error}"))
}

#[tauri::command]
pub async fn initialize_database(folderPath: String) -> Result<DatabaseInfo, String> {
    let (connection, info) = openDatabase(&folderPath).await?;
    connection
        .close()
        .await
        .map_err(|error| format!("Unable to close the database: {error}"))?;
    Ok(info)
}

pub(crate) async fn openDatabase(
    folderPath: &str,
) -> Result<(SqliteConnection, DatabaseInfo), String> {
    let requestedPath = Path::new(&folderPath);
    if !requestedPath.is_absolute() {
        return Err("The notes folder path must be absolute.".into());
    }

    let folderPath = requestedPath
        .canonicalize()
        .map_err(|error| format!("Unable to access the notes folder: {error}"))?;
    if !folderPath.is_dir() {
        return Err("The notes folder path must point to an existing directory.".into());
    }

    let databasePath = folderPath.join(DATABASE_FILE_NAME);
    let databasePathText = databasePath
        .to_str()
        .ok_or("The database path must contain valid Unicode.")?
        .to_owned();

    // Pass a filesystem path directly; spaces, # and ? must not become URI options.
    let options = SqliteConnectOptions::new()
        .filename(&databasePath)
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the database: {error}"))?;

    let migrationResult = createDatabaseTables(&mut connection).await;
    let schemaVersion = migrationResult?;
    Ok((
        connection,
        DatabaseInfo {
            databasePath: databasePathText,
            schemaVersion,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_repeatable_and_enforce_question_constraints() {
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            sqlx::query("PRAGMA foreign_keys = ON")
                .execute(&mut connection)
                .await
                .unwrap();
            assert_eq!(createDatabaseTables(&mut connection).await.unwrap(), 9);
            sqlx::query("INSERT INTO notes (id, filePath) VALUES ('note', 'note.md')")
                .execute(&mut connection)
                .await
                .unwrap();
            assert_eq!(createDatabaseTables(&mut connection).await.unwrap(), 9);
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(count, 1);

            let invalidQuestion = "INSERT INTO questions (id, noteId, text, exampleAnswer, difficulty, format, choices, correctChoiceIndex) VALUES ('bad', 'note', 'Q', 'A', 0, 0, '[\"A\",\"B\"]', 2)";
            assert!(
                sqlx::query(invalidQuestion)
                    .execute(&mut connection)
                    .await
                    .is_err()
            );
            let validQuestion = "INSERT INTO questions (id, noteId, text, exampleAnswer, difficulty, format, maxCharacters, answerCriteria) VALUES ('question', 'note', 'Q', 'A', 1, 1, 500, 'Explain why')";
            sqlx::query(validQuestion)
                .execute(&mut connection)
                .await
                .unwrap();
            assert!(
                sqlx::query("INSERT INTO questionFsrs VALUES ('missing', '{}')")
                    .execute(&mut connection)
                    .await
                    .is_err()
            );
        });
    }

    #[test]
    fn initialization_uses_the_selected_folder_and_preserves_data() {
        tauri::async_runtime::block_on(async {
            let suffix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let folderPath = std::env::temp_dir().join(format!("obstudy test #? {suffix}"));
            std::fs::create_dir(&folderPath).unwrap();
            let first = initialize_database(folderPath.to_str().unwrap().into())
                .await
                .unwrap();
            assert_eq!(
                Path::new(&first.databasePath),
                folderPath.canonicalize().unwrap().join("obstudy.db")
            );
            assert!(Path::new(&first.databasePath).is_file());
            assert_eq!(
                initialize_database(folderPath.to_str().unwrap().into())
                    .await
                    .unwrap()
                    .schemaVersion,
                9
            );
            assert!(initialize_database("relative/path".into()).await.is_err());
            assert!(initialize_database(first.databasePath).await.is_err());
            std::fs::remove_dir_all(folderPath).unwrap();
        });
    }
}
