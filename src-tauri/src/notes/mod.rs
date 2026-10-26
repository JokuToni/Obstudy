#![allow(non_snake_case)]
pub mod parser;
pub(crate) mod snapshot;

use parser::{TopicParseResult, extract_topics, has_study_tag};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Connection, Row, SqliteConnection};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Default)]
pub struct NotesState(pub tokio::sync::Mutex<()>);
#[derive(Serialize, Deserialize, Clone)]
pub struct SyncWarning {
    pub filePath: String,
    pub message: String,
}
#[derive(Serialize)]
pub struct NoteSyncResult {
    pub notes: Vec<Value>,
    pub warnings: Vec<SyncWarning>,
}
struct ScannedFile {
    path: String,
    text: String,
    eligible: Option<bool>,
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn db_error(error: sqlx::Error) -> String {
    format!("Unable to synchronize notes: {error}")
}

fn scan_folder(folder: &Path) -> Result<Vec<ScannedFile>, String> {
    let mut files = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("Unable to read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if !matches!(
                    entry.file_name().to_str(),
                    Some(".obsidian" | ".git" | ".trash")
                ) {
                    pending.push(path);
                }
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                let text = std::fs::read_to_string(&path).map_err(|error| {
                    format!(
                        "Unable to read {}: {error}. No notes were marked missing.",
                        path.display()
                    )
                })?;
                let eligible = has_study_tag(&text).ok();
                files.push(ScannedFile {
                    path: path
                        .to_str()
                        .ok_or("Note paths must contain valid Unicode.")?
                        .into(),
                    text,
                    eligible,
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

async fn issue(
    connection: &mut SqliteConnection,
    noteId: &str,
    kind: &str,
    topicId: &str,
    topicKind: &str,
    title: &str,
) -> Result<(), String> {
    sqlx::query("INSERT INTO noteSyncIssues (id, noteId, kind, topicId, topicKind, title) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(noteId, kind, topicId) DO UPDATE SET title = excluded.title")
        .bind(id()).bind(noteId).bind(kind).bind(topicId).bind(topicKind).bind(title).execute(connection).await.map_err(db_error)?;
    Ok(())
}

async fn has_questions(
    connection: &mut SqliteConnection,
    topicId: &str,
    broad: bool,
) -> Result<bool, String> {
    let query = if broad {
        "SELECT EXISTS(SELECT 1 FROM questionBroadTopics link JOIN questions q ON q.id = link.questionId WHERE link.topicId = ? AND q.isArchived = 0)"
    } else {
        "SELECT EXISTS(SELECT 1 FROM questionSubtopics link JOIN questions q ON q.id = link.questionId WHERE link.topicId = ? AND q.isArchived = 0)"
    };
    sqlx::query_scalar(query)
        .bind(topicId)
        .fetch_one(connection)
        .await
        .map_err(db_error)
}

async fn sync_topics(
    connection: &mut SqliteConnection,
    noteId: &str,
    parsed: &TopicParseResult,
) -> Result<(), String> {
    let oldBroad = sqlx::query("SELECT id, title, isPresent FROM broadTopics WHERE noteId = ? ORDER BY isPresent DESC, rowid").bind(noteId).fetch_all(&mut *connection).await.map_err(db_error)?;
    let oldSub = sqlx::query("SELECT id, title, text, broadTopicId, isPresent FROM subtopics WHERE noteId = ? ORDER BY isPresent DESC, rowid").bind(noteId).fetch_all(&mut *connection).await.map_err(db_error)?;
    let mut used = HashSet::new();
    let mut broadIds = Vec::new();
    for topic in &parsed.broadTopics {
        let existing = oldBroad.iter().find(|row| {
            row.get::<String, _>("title") == topic.title
                && !used.contains(&row.get::<String, _>("id"))
        });
        let topicId = existing
            .map(|row| row.get::<String, _>("id"))
            .unwrap_or_else(id);
        used.insert(topicId.clone());
        sqlx::query("INSERT INTO broadTopics (id, noteId, title, isPresent) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET isPresent = 1")
            .bind(&topicId).bind(noteId).bind(&topic.title).execute(&mut *connection).await.map_err(db_error)?;
        sqlx::query("DELETE FROM noteSyncIssues WHERE topicId = ? AND kind = 'topicRemoved'")
            .bind(&topicId)
            .execute(&mut *connection)
            .await
            .map_err(db_error)?;
        broadIds.push(topicId);
    }
    let removedBroad: HashSet<String> = oldBroad
        .iter()
        .map(|row| row.get::<String, _>("id"))
        .filter(|topicId| !used.contains(topicId))
        .collect();
    let mut usedSub = HashSet::new();
    for topic in &parsed.subtopics {
        let parentId = topic
            .broadTopicIndex
            .and_then(|index| broadIds.get(index))
            .cloned();
        let existing = oldSub
            .iter()
            .filter(|row| {
                row.get::<String, _>("title") == topic.title
                    && !usedSub.contains(&row.get::<String, _>("id"))
            })
            .min_by_key(|row| {
                if row.get::<Option<String>, _>("broadTopicId") == parentId {
                    0
                } else {
                    1
                }
            });
        let topicId = existing
            .map(|row| row.get::<String, _>("id"))
            .unwrap_or_else(id);
        if let Some(old) = existing {
            if old.get::<String, _>("text") != topic.text
                && has_questions(connection, &topicId, false).await?
            {
                issue(
                    connection,
                    noteId,
                    "topicChanged",
                    &topicId,
                    "subtopic",
                    &topic.title,
                )
                .await?;
            }
            if old
                .get::<Option<String>, _>("broadTopicId")
                .is_some_and(|parent| removedBroad.contains(&parent))
            {
                issue(
                    connection,
                    noteId,
                    "orphanedSubtopic",
                    &topicId,
                    "subtopic",
                    &topic.title,
                )
                .await?;
            }
        }
        sqlx::query("INSERT INTO subtopics (id, noteId, title, text, broadTopicId, isPresent) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET text = excluded.text, broadTopicId = excluded.broadTopicId, isPresent = 1")
            .bind(&topicId).bind(noteId).bind(&topic.title).bind(&topic.text).bind(&parentId).execute(&mut *connection).await.map_err(db_error)?;
        sqlx::query("DELETE FROM noteSyncIssues WHERE topicId = ? AND kind = 'topicRemoved'")
            .bind(&topicId)
            .execute(&mut *connection)
            .await
            .map_err(db_error)?;
        usedSub.insert(topicId);
    }
    // Broad-topic questions also depend on their child topics' content.
    for (index, broadId) in broadIds.iter().enumerate() {
        if !oldBroad
            .iter()
            .any(|row| row.get::<String, _>("id") == *broadId && row.get::<bool, _>("isPresent"))
        {
            continue;
        }
        let mut previous: Vec<(String, String)> = oldSub
            .iter()
            .filter(|row| {
                row.get::<bool, _>("isPresent")
                    && row.get::<Option<String>, _>("broadTopicId").as_deref() == Some(broadId)
            })
            .map(|row| (row.get("title"), row.get("text")))
            .collect();
        let mut current: Vec<(String, String)> = parsed
            .subtopics
            .iter()
            .filter(|topic| topic.broadTopicIndex == Some(index))
            .map(|topic| (topic.title.clone(), topic.text.clone()))
            .collect();
        previous.sort();
        current.sort();
        if previous != current && has_questions(connection, broadId, true).await? {
            issue(
                connection,
                noteId,
                "topicChanged",
                broadId,
                "broad",
                &parsed.broadTopics[index].title,
            )
            .await?;
        }
    }
    for row in &oldSub {
        let topicId: String = row.get("id");
        if !usedSub.contains(&topicId) {
            sqlx::query("UPDATE subtopics SET isPresent = 0 WHERE id = ?")
                .bind(&topicId)
                .execute(&mut *connection)
                .await
                .map_err(db_error)?;
            if has_questions(connection, &topicId, false).await? {
                issue(
                    connection,
                    noteId,
                    "topicRemoved",
                    &topicId,
                    "subtopic",
                    &row.get::<String, _>("title"),
                )
                .await?;
            }
            sqlx::query("DELETE FROM noteSyncIssues WHERE topicId = ? AND kind IN ('topicChanged', 'orphanedSubtopic')").bind(&topicId).execute(&mut *connection).await.map_err(db_error)?;
        }
    }
    for row in &oldBroad {
        let topicId: String = row.get("id");
        if removedBroad.contains(&topicId) {
            sqlx::query("DELETE FROM noteSyncIssues WHERE topicId = ? AND kind = 'topicChanged'")
                .bind(&topicId)
                .execute(&mut *connection)
                .await
                .map_err(db_error)?;
            sqlx::query("UPDATE broadTopics SET isPresent = 0 WHERE id = ?")
                .bind(&topicId)
                .execute(&mut *connection)
                .await
                .map_err(db_error)?;
            if has_questions(connection, &topicId, true).await? {
                issue(
                    connection,
                    noteId,
                    "topicRemoved",
                    &topicId,
                    "broad",
                    &row.get::<String, _>("title"),
                )
                .await?;
            }
        }
    }
    Ok(())
}

async fn apply_scan(
    connection: &mut SqliteConnection,
    files: Vec<ScannedFile>,
) -> Result<Vec<SyncWarning>, String> {
    let oldNotes = sqlx::query("SELECT id, filePath, text, isAvailable FROM notes")
        .fetch_all(&mut *connection)
        .await
        .map_err(db_error)?;
    let scannedPaths: HashSet<_> = files.iter().map(|file| file.path.as_str()).collect();
    let mut seen = HashSet::new();
    let mut warnings = Vec::new();
    for file in &files {
        let existing = oldNotes
            .iter()
            .find(|row| row.get::<String, _>("filePath") == file.path);
        if file.eligible.is_none() {
            if let Some(row) = existing {
                seen.insert(row.get::<String, _>("id"));
            }
            warnings.push(SyncWarning {
                filePath: file.path.clone(),
                message: "Invalid YAML frontmatter; existing study data was left unchanged.".into(),
            });
            continue;
        }
        if file.eligible != Some(true) {
            continue;
        }
        // A unique, unchanged file moved inside the vault keeps its saved identity.
        let renameCandidates: Vec<_> = oldNotes
            .iter()
            .filter(|row| {
                !scannedPaths.contains(row.get::<String, _>("filePath").as_str())
                    && row.get::<String, _>("text") == file.text
                    && !seen.contains(&row.get::<String, _>("id"))
            })
            .collect();
        let newFileMatches = files
            .iter()
            .filter(|candidate| {
                candidate.eligible == Some(true)
                    && candidate.text == file.text
                    && !oldNotes
                        .iter()
                        .any(|row| row.get::<String, _>("filePath") == candidate.path)
            })
            .count();
        let existing = existing.or_else(|| {
            if renameCandidates.len() == 1 && newFileMatches == 1 {
                Some(renameCandidates[0])
            } else {
                None
            }
        });
        let noteId = existing
            .map(|row| row.get::<String, _>("id"))
            .unwrap_or_else(id);
        seen.insert(noteId.clone());
        let parsed = extract_topics(&file.text);
        let parseError = parsed.as_ref().err().cloned();
        let parseWarnings = parsed
            .as_ref()
            .map(|result| result.warnings.clone())
            .unwrap_or_default();
        sqlx::query("INSERT INTO notes (id, filePath, text, isAvailable, parseError, parseWarnings) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET filePath = excluded.filePath, text = excluded.text, isAvailable = 1, parseError = excluded.parseError, parseWarnings = excluded.parseWarnings")
            .bind(&noteId).bind(&file.path).bind(&file.text).bind(&parseError).bind(json!(parseWarnings).to_string()).execute(&mut *connection).await.map_err(db_error)?;
        if let Ok(parsed) = parsed {
            sync_topics(connection, &noteId, &parsed).await?;
        }
        if let Some(message) = parseError {
            warnings.push(SyncWarning {
                filePath: file.path.clone(),
                message,
            });
        }
        for message in parseWarnings {
            warnings.push(SyncWarning {
                filePath: file.path.clone(),
                message,
            });
        }
    }
    for row in oldNotes {
        let noteId: String = row.get("id");
        if !seen.contains(&noteId) {
            sqlx::query("UPDATE notes SET isAvailable = 0 WHERE id = ?")
                .bind(&noteId)
                .execute(&mut *connection)
                .await
                .map_err(db_error)?;
            warnings.push(SyncWarning { filePath: row.get("filePath"), message: "Note is missing or no longer tagged STUDY. Saved questions and history were retained.".into() });
        }
    }
    Ok(warnings)
}

#[tauri::command]
pub async fn extract_note_topics(text: String) -> Result<TopicParseResult, String> {
    extract_topics(&text)
}

#[tauri::command]
pub async fn fetch_obsidian_notes(
    folderPath: String,
    state: tauri::State<'_, NotesState>,
) -> Result<NoteSyncResult, String> {
    let _guard = state.0.lock().await;
    sync_folder(folderPath).await
}

async fn sync_folder(folderPath: String) -> Result<NoteSyncResult, String> {
    let root = PathBuf::from(&folderPath);
    if !root.is_absolute() {
        return Err("The notes folder path must be absolute.".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("Unable to access the notes folder: {error}"))?;
    let files = tauri::async_runtime::spawn_blocking(move || scan_folder(&root))
        .await
        .map_err(|_| "Unable to scan the notes folder.")??;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(db_error)?;
    let warnings = apply_scan(&mut transaction, files).await?;
    cleanup_issues(&mut transaction).await?;
    let notes = snapshot::load_notes(&mut transaction).await?;
    transaction.commit().await.map_err(db_error)?;
    connection.close().await.map_err(db_error)?;
    Ok(NoteSyncResult { notes, warnings })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueAction {
    KeepQuestions,
    ArchiveQuestions,
    DetachParent,
    AssignParent,
}

#[tauri::command]
pub async fn set_note_studying(
    folderPath: String,
    noteId: String,
    isStudying: bool,
    state: tauri::State<'_, NotesState>,
) -> Result<(), String> {
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    let result = update_study_status(&mut connection, &noteId, isStudying).await;
    connection.close().await.map_err(db_error)?;
    result
}

async fn update_study_status(
    connection: &mut SqliteConnection,
    noteId: &str,
    isStudying: bool,
) -> Result<(), String> {
    let result = sqlx::query("UPDATE notes SET isStudying = ? WHERE id = ? AND isAvailable = 1")
        .bind(isStudying)
        .bind(noteId)
        .execute(connection)
        .await
        .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err("This note is unavailable. Synchronize your notes and try again.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn resolve_note_issue(
    folderPath: String,
    issueId: String,
    action: IssueAction,
    broadTopicId: Option<String>,
    state: tauri::State<'_, NotesState>,
) -> Result<NoteSyncResult, String> {
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(db_error)?;
    resolve_issue(&mut transaction, &issueId, action, broadTopicId).await?;
    cleanup_issues(&mut transaction).await?;
    let notes = snapshot::load_notes(&mut transaction).await?;
    transaction.commit().await.map_err(db_error)?;
    connection.close().await.map_err(db_error)?;
    Ok(NoteSyncResult {
        notes,
        warnings: Vec::new(),
    })
}

async fn resolve_issue(
    connection: &mut SqliteConnection,
    issueId: &str,
    action: IssueAction,
    broadTopicId: Option<String>,
) -> Result<(), String> {
    let row = sqlx::query("SELECT * FROM noteSyncIssues WHERE id = ?")
        .bind(issueId)
        .fetch_optional(&mut *connection)
        .await
        .map_err(db_error)?
        .ok_or("This change has already been resolved. Refresh your notes.")?;
    let noteId: String = row.get("noteId");
    let topicId: String = row.get("topicId");
    let kind: String = row.get("kind");
    let broad = row.get::<String, _>("topicKind") == "broad";
    let linkTable = if broad {
        "questionBroadTopics"
    } else {
        "questionSubtopics"
    };
    let questionIds: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT questionId FROM {linkTable} WHERE topicId = ?"
    ))
    .bind(&topicId)
    .fetch_all(&mut *connection)
    .await
    .map_err(db_error)?;
    if kind == "orphanedSubtopic" {
        if !matches!(
            action,
            IssueAction::DetachParent | IssueAction::AssignParent
        ) {
            return Err("Choose whether to reassign or detach the missing broad topic.".into());
        }
        if matches!(action, IssueAction::AssignParent) {
            let target = broadTopicId.as_deref().ok_or("Select a broad topic.")?;
            let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM broadTopics WHERE id = ? AND noteId = ? AND isPresent = 1)").bind(target).bind(&noteId).fetch_one(&mut *connection).await.map_err(db_error)?;
            if !valid {
                return Err("The selected broad topic does not belong to this note.".into());
            }
        }
        for questionId in &questionIds {
            sqlx::query("DELETE FROM questionBroadTopics WHERE questionId = ? AND topicId IN (SELECT id FROM broadTopics WHERE noteId = ? AND isPresent = 0)").bind(questionId).bind(&noteId).execute(&mut *connection).await.map_err(db_error)?;
            if matches!(action, IssueAction::AssignParent) {
                sqlx::query(
                    "INSERT OR IGNORE INTO questionBroadTopics (questionId, topicId) VALUES (?, ?)",
                )
                .bind(questionId)
                .bind(&broadTopicId)
                .execute(&mut *connection)
                .await
                .map_err(db_error)?;
            }
        }
    } else {
        if !matches!(
            action,
            IssueAction::KeepQuestions | IssueAction::ArchiveQuestions
        ) {
            return Err("Choose whether to keep or remove the affected questions.".into());
        }
        for questionId in &questionIds {
            // Surviving subtopics are reviewed separately when their broad topic disappeared.
            if broad && kind == "topicRemoved" {
                let surviving: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM questionSubtopics link JOIN subtopics s ON s.id = link.topicId WHERE link.questionId = ? AND s.isPresent = 1)").bind(questionId).fetch_one(&mut *connection).await.map_err(db_error)?;
                if surviving {
                    continue;
                }
            }
            if matches!(action, IssueAction::ArchiveQuestions) {
                sqlx::query("UPDATE questions SET isArchived = 1 WHERE id = ?")
                    .bind(questionId)
                    .execute(&mut *connection)
                    .await
                    .map_err(db_error)?;
            }
            if kind == "topicRemoved" {
                sqlx::query(&format!(
                    "DELETE FROM {linkTable} WHERE questionId = ? AND topicId = ?"
                ))
                .bind(questionId)
                .bind(&topicId)
                .execute(&mut *connection)
                .await
                .map_err(db_error)?;
            }
        }
    }
    sqlx::query("DELETE FROM noteSyncIssues WHERE id = ?")
        .bind(issueId)
        .execute(connection)
        .await
        .map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ops::DerefMut;

    const ORIGINAL: &str = "---\ntags: [STUDY]\n---\n**Math**\n1. **Rates**\n- Original content\n";
    fn vault() -> PathBuf {
        let root = std::env::temp_dir().join(format!("obstudy-sync-{}", id()));
        std::fs::create_dir(&root).unwrap();
        root
    }
    async fn seed_question(root: &Path, note: &Value) -> (String, String) {
        let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
            .await
            .unwrap();
        let topic = note["topics"]
            .as_array()
            .unwrap()
            .iter()
            .find(|topic| topic.get("text").is_some())
            .unwrap();
        let topicId = topic["id"].as_str().unwrap().to_owned();
        let broadId = topic["broadTopicId"].as_str().unwrap().to_owned();
        sqlx::query("UPDATE notes SET isStudying = 1 WHERE id = ?")
            .bind(note["id"].as_str().unwrap())
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO questions (id, noteId, text, exampleAnswer, difficulty, format, maxCharacters, answerCriteria) VALUES ('question', ?, 'Why?', 'Because', 0, 1, 100, 'Explanation')").bind(note["id"].as_str().unwrap()).execute(&mut connection).await.unwrap();
        sqlx::query("INSERT INTO questionSubtopics VALUES ('question', ?)")
            .bind(&topicId)
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO questionBroadTopics VALUES ('question', ?)")
            .bind(&broadId)
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        (topicId, broadId)
    }
    #[test]
    fn study_status_is_persisted_without_changing_note_data() {
        tauri::async_runtime::block_on(async {
            let root = vault();
            std::fs::write(root.join("note.md"), ORIGINAL).unwrap();
            let first = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            let noteId = first.notes[0]["id"].as_str().unwrap();
            let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            update_study_status(&mut connection, noteId, true)
                .await
                .unwrap();
            connection.close().await.unwrap();
            let studying = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(studying.notes[0]["isStudying"], true);
            assert_eq!(studying.notes[0]["topics"], first.notes[0]["topics"]);
            assert_eq!(studying.notes[0]["file"], first.notes[0]["file"]);

            let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            update_study_status(&mut connection, noteId, false)
                .await
                .unwrap();
            assert!(
                update_study_status(&mut connection, "missing", true)
                    .await
                    .is_err()
            );
            sqlx::query("UPDATE notes SET isAvailable = 0 WHERE id = ?")
                .bind(noteId)
                .execute(&mut connection)
                .await
                .unwrap();
            assert!(
                update_study_status(&mut connection, noteId, true)
                    .await
                    .is_err()
            );
            connection.close().await.unwrap();
            let notStudying = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(notStudying.notes[0]["isStudying"], false);
            std::fs::remove_dir_all(root).unwrap();
        });
    }
    #[test]
    fn startup_sync_is_recursive_repeatable_and_preserves_saved_identity() {
        tauri::async_runtime::block_on(async {
            let root = vault();
            std::fs::create_dir(root.join("nested")).unwrap();
            std::fs::create_dir(root.join(".obsidian")).unwrap();
            std::fs::write(root.join("nested/note.md"), ORIGINAL).unwrap();
            std::fs::write(root.join(".obsidian/ignored.md"), ORIGINAL).unwrap();
            std::fs::write(root.join("ordinary.md"), "Ordinary notes").unwrap();
            let first = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(first.notes.len(), 1);
            assert_eq!(first.notes[0]["topics"].as_array().unwrap().len(), 2);
            let (topicId, _) = seed_question(&root, &first.notes[0]).await;
            let second = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(first.notes[0]["id"], second.notes[0]["id"]);
            assert_eq!(second.notes[0]["isStudying"], true);
            assert_eq!(second.notes[0]["questions"].as_array().unwrap().len(), 1);
            assert_eq!(second.notes[0]["syncIssues"], json!([]));
            assert!(
                second.notes[0]["topics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|topic| topic["id"] == topicId)
            );
            std::fs::rename(root.join("nested/note.md"), root.join("moved.md")).unwrap();
            let moved = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(moved.notes[0]["id"], first.notes[0]["id"]);
            std::fs::write(root.join("moved.md"), "No study tag anymore").unwrap();
            let untagged = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(untagged.notes[0]["isAvailable"], false);
            assert_eq!(untagged.notes[0]["questions"].as_array().unwrap().len(), 1);
            std::fs::remove_dir_all(root).unwrap();
        });
    }
    #[test]
    fn changed_and_removed_topics_require_persisted_user_decisions() {
        tauri::async_runtime::block_on(async {
            let root = vault();
            let path = root.join("note.md");
            std::fs::write(&path, ORIGINAL).unwrap();
            let first = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            seed_question(&root, &first.notes[0]).await;
            std::fs::write(&path, ORIGINAL.replace("Original", "Updated")).unwrap();
            let changed = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            let changedId = changed.notes[0]["syncIssues"][0]["id"].as_str().unwrap();
            assert_eq!(changed.notes[0]["syncIssues"][0]["kind"], "topicChanged");
            let again = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(again.notes[0]["syncIssues"][0]["id"], changedId);
            let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            let mut transaction = connection.begin().await.unwrap();
            resolve_issue(
                transaction.deref_mut(),
                changedId,
                IssueAction::KeepQuestions,
                None,
            )
            .await
            .unwrap();
            transaction.commit().await.unwrap();
            connection.close().await.unwrap();
            std::fs::write(
                &path,
                "#STUDY\n**Math**\n1. **Replacement**\n- New material\n",
            )
            .unwrap();
            let removed = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert_eq!(removed.notes[0]["questions"].as_array().unwrap().len(), 1);
            let removedId = removed.notes[0]["syncIssues"][0]["id"].as_str().unwrap();
            let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            let mut transaction = connection.begin().await.unwrap();
            resolve_issue(
                transaction.deref_mut(),
                removedId,
                IssueAction::ArchiveQuestions,
                None,
            )
            .await
            .unwrap();
            transaction.commit().await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT isArchived FROM questions WHERE id = 'question'"
                )
                .fetch_one(&mut connection)
                .await
                .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM questions")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap(),
                1
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }
    #[test]
    fn invalid_parse_retains_old_topics_and_failed_scan_cannot_mark_notes_missing() {
        tauri::async_runtime::block_on(async {
            let root = vault();
            let path = root.join("note.md");
            std::fs::write(&path, ORIGINAL).unwrap();
            let first = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            std::fs::write(&path, "#STUDY\nUnstructured content").unwrap();
            let invalid = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            assert!(invalid.notes[0]["parseError"].is_string());
            assert_eq!(invalid.notes[0]["topics"], first.notes[0]["topics"]);
            std::fs::remove_file(&path).unwrap();
            std::fs::write(root.join("bad.md"), [0xff, 0xfe]).unwrap();
            assert!(sync_folder(root.to_str().unwrap().into()).await.is_err());
            let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT isAvailable FROM notes")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap(),
                1
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }
    #[test]
    fn orphan_reassignment_is_validated_and_old_parent_links_are_detached() {
        tauri::async_runtime::block_on(async {
            let root = vault();
            let path = root.join("note.md");
            std::fs::write(&path, ORIGINAL).unwrap();
            let first = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            let (_, oldBroad) = seed_question(&root, &first.notes[0]).await;
            std::fs::write(
                &path,
                "#STUDY\n1. **Rates**\n- Original content\n**New parent**\n2. **Other**\n- More\n",
            )
            .unwrap();
            let orphaned = sync_folder(root.to_str().unwrap().into()).await.unwrap();
            let issue = orphaned.notes[0]["syncIssues"]
                .as_array()
                .unwrap()
                .iter()
                .find(|issue| issue["kind"] == "orphanedSubtopic")
                .unwrap();
            let issueId = issue["id"].as_str().unwrap();
            let parent = orphaned.notes[0]["topics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|topic| topic["title"] == "New parent")
                .unwrap()["id"]
                .as_str()
                .unwrap();
            let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            let mut transaction = connection.begin().await.unwrap();
            assert!(
                resolve_issue(
                    transaction.deref_mut(),
                    issueId,
                    IssueAction::AssignParent,
                    Some("foreign-topic".into())
                )
                .await
                .is_err()
            );
            resolve_issue(
                transaction.deref_mut(),
                issueId,
                IssueAction::AssignParent,
                Some(parent.into()),
            )
            .await
            .unwrap();
            transaction.commit().await.unwrap();
            let links: Vec<String> = sqlx::query_scalar(
                "SELECT topicId FROM questionBroadTopics WHERE questionId = 'question'",
            )
            .fetch_all(&mut connection)
            .await
            .unwrap();
            assert_eq!(links, vec![parent.to_string()]);
            assert!(!links.contains(&oldBroad));
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }
}

async fn cleanup_issues(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("DELETE FROM noteSyncIssues WHERE kind IN ('topicChanged', 'topicRemoved') AND ((topicKind = 'broad' AND NOT EXISTS (SELECT 1 FROM questionBroadTopics link JOIN questions q ON q.id = link.questionId WHERE link.topicId = noteSyncIssues.topicId AND q.isArchived = 0)) OR (topicKind = 'subtopic' AND NOT EXISTS (SELECT 1 FROM questionSubtopics link JOIN questions q ON q.id = link.questionId WHERE link.topicId = noteSyncIssues.topicId AND q.isArchived = 0)))").execute(connection).await.map_err(db_error)?;
    Ok(())
}
