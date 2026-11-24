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
            assert_eq!(createDatabaseTables(&mut connection).await.unwrap(), 13);
            sqlx::query("INSERT INTO notes (id, filePath) VALUES ('note', 'note.md')")
                .execute(&mut connection)
                .await
                .unwrap();
            assert_eq!(createDatabaseTables(&mut connection).await.unwrap(), 13);
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
    fn original_fsrs_migration_upgrades_without_changing_its_checksum_or_saved_data() {
        tauri::async_runtime::block_on(async {
            use sqlx::migrate::Migrate;
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            // The original dev migration was already applied before its follow-up field.
            assert_eq!(
                MIGRATIONS
                    .iter()
                    .find(|migration| migration.version == 10)
                    .unwrap()
                    .checksum
                    .as_ref(),
                &[
                    43, 226, 76, 31, 133, 116, 100, 118, 205, 56, 164, 26, 35, 151, 240, 198, 9,
                    121, 196, 74, 170, 108, 119, 162, 0, 2, 170, 55, 139, 179, 26, 121, 24, 231,
                    122, 244, 234, 223, 38, 142, 35, 67, 216, 241, 164, 164, 71, 101
                ]
            );
            connection.ensure_migrations_table().await.unwrap();
            for migration in MIGRATIONS
                .iter()
                .filter(|migration| migration.version <= 10)
            {
                connection.apply(migration).await.unwrap();
            }
            sqlx::raw_sql(r#"INSERT INTO notes (id,filePath) VALUES ('note','note.md');
                INSERT INTO questions (id,noteId,text,exampleAnswer,difficulty,format,maxCharacters,answerCriteria,isBasicQuestion) VALUES ('q','note','Question','Answer',0,1,100,'Criteria',1);
                INSERT INTO questionFsrs VALUES ('q','{"due":"2026-11-06T12:00:00Z","reps":3}');
                INSERT INTO practiceSettings (id,noteId,questionCount,difficulty,reuseQuestions,questionFormat) VALUES ('settings','note',10,0,1,2);
                INSERT INTO exercises (id,noteId,settingsId,mode,maxPoints) VALUES ('exercise','note','settings','study',1);
                INSERT INTO exerciseQuestions (exerciseId,questionId,position,questionSnapshot) VALUES ('exercise','q',0,'{}');
                INSERT INTO submittedAnswers (id,exerciseId,questionId,answeredAt,text,points) VALUES ('answer','exercise','q','2026-11-06T12:00:00Z','Saved answer',1);"#)
                .execute(&mut connection).await.unwrap();
            let before: String =
                sqlx::query_scalar("SELECT fsrsData FROM questionFsrs WHERE questionId='q'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(createDatabaseTables(&mut connection).await.unwrap(), 13);
            assert_eq!(createDatabaseTables(&mut connection).await.unwrap(), 13);
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT fsrsData FROM questionFsrs WHERE questionId='q'"
                )
                .fetch_one(&mut connection)
                .await
                .unwrap(),
                before
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT text FROM submittedAnswers WHERE id='answer'"
                )
                .fetch_one(&mut connection)
                .await
                .unwrap(),
                "Saved answer"
            );
            assert_eq!(
                sqlx::query_scalar::<_, bool>(
                    "SELECT fsrsPending FROM submittedAnswers WHERE id='answer'"
                )
                .fetch_one(&mut connection)
                .await
                .unwrap(),
                false
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
                13
            );
            assert!(initialize_database("relative/path".into()).await.is_err());
            assert!(initialize_database(first.databasePath).await.is_err());
            std::fs::remove_dir_all(folderPath).unwrap();
        });
    }
}
