#![allow(non_snake_case)]

use crate::notes::{NotesState, snapshot};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Connection, SqliteConnection};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionDraft {
    text: String,
    exampleAnswer: String,
    topicIds: Vec<String>,
    difficulty: u8,
    format: u8,
    choices: Option<Vec<String>>,
    correctChoiceIndex: Option<usize>,
    maxCharacters: Option<u32>,
    answerCriteria: Option<String>,
    fsrsData: Option<Value>,
}

#[derive(Deserialize)]
pub struct QuestionBatch {
    noteId: String,
    sourceText: String,
    sourceTopics: Value,
    expectedQuestionIds: Vec<String>,
    isBasicQuestion: bool,
    scope: String,
    model: String,
    difficulty: u8,
    format: u8,
    targetCount: usize,
    allowedTopicIds: Vec<String>,
    questions: Vec<QuestionDraft>,
}

fn storage_error(error: sqlx::Error) -> String {
    format!("Unable to save generated questions: {error}")
}

pub(crate) async fn load_note(
    connection: &mut SqliteConnection,
    noteId: &str,
) -> Result<Value, String> {
    snapshot::load_note(connection, noteId).await
}

#[tauri::command]
pub async fn get_question_generation_note(
    state: tauri::State<'_, NotesState>,
    folderPath: String,
    noteId: String,
) -> Result<Value, String> {
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    load_note(&mut connection, &noteId).await
}

fn normalized(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn validate_card(card: &Value) -> bool {
    card.is_object()
        && card["due"]
            .as_str()
            .is_some_and(|due| due.ends_with('Z') && due.contains('T'))
        && [
            "stability",
            "difficulty",
            "elapsed_days",
            "scheduled_days",
            "learning_steps",
            "reps",
            "lapses",
            "state",
        ]
        .iter()
        .all(|key| card[*key].as_u64() == Some(0))
        && card.get("last_review").is_none()
}

fn validate_draft(
    draft: &QuestionDraft,
    batch: &QuestionBatch,
    allowed: &HashSet<&str>,
) -> Result<(), String> {
    if draft.text.trim().is_empty()
        || draft.exampleAnswer.trim().is_empty()
        || draft.difficulty != batch.difficulty
        || draft.format != batch.format
        || draft.topicIds.is_empty()
        || draft
            .topicIds
            .iter()
            .any(|id| !allowed.contains(id.as_str()))
        || draft.topicIds.iter().collect::<HashSet<_>>().len() != draft.topicIds.len()
    {
        return Err(
            "The generated question has invalid content, difficulty, format, or topics.".into(),
        );
    }
    match draft.format {
        0 => {
            let choices = draft
                .choices
                .as_ref()
                .ok_or("Multiple-choice answers are missing.")?;
            if choices.len() != 4
                || choices.iter().any(|choice| choice.trim().is_empty())
                || choices
                    .iter()
                    .map(|choice| normalized(choice))
                    .collect::<HashSet<_>>()
                    .len()
                    != 4
                || !draft
                    .correctChoiceIndex
                    .is_some_and(|index| index < choices.len())
                || draft.maxCharacters.is_some()
                || draft.answerCriteria.is_some()
            {
                return Err("The generated multiple-choice question is invalid.".into());
            }
        }
        1 => {
            if !draft.maxCharacters.is_some_and(|limit| limit > 0)
                || !draft
                    .answerCriteria
                    .as_ref()
                    .is_some_and(|criteria| !criteria.trim().is_empty())
                || draft.choices.is_some()
                || draft.correctChoiceIndex.is_some()
            {
                return Err("The generated free-text question is invalid.".into());
            }
        }
        _ => return Err("Unsupported question format.".into()),
    }
    if batch.isBasicQuestion {
        if !draft.fsrsData.as_ref().is_some_and(validate_card) {
            return Err("A basic question requires a new FSRS card.".into());
        }
    } else if draft.fsrsData.is_some() {
        return Err("Additional questions cannot have FSRS cards.".into());
    }
    Ok(())
}

async fn save_batch(
    connection: &mut SqliteConnection,
    batch: &QuestionBatch,
) -> Result<(), String> {
    let note = load_note(connection, &batch.noteId).await?;
    if note["isAvailable"] != true
        || !note["parseError"].is_null()
        || note["syncIssues"]
            .as_array()
            .is_none_or(|issues| !issues.is_empty())
    {
        return Err(
            "Resolve note errors and pending topic changes before generating questions.".into(),
        );
    }
    let existing = note["questions"]
        .as_array()
        .ok_or("Invalid stored questions.")?;
    let existingIds: HashSet<_> = existing.iter().filter_map(|q| q["id"].as_str()).collect();
    if note["file"]["text"].as_str() != Some(&batch.sourceText)
        || note["topics"] != batch.sourceTopics
        || existingIds
            != batch
                .expectedQuestionIds
                .iter()
                .map(String::as_str)
                .collect()
    {
        return Err("The note or its questions changed during generation. Please try again; previously saved batches are preserved.".into());
    }
    if batch.difficulty > 2
        || batch.format > 1
        || batch.model.trim().is_empty()
        || batch.scope.is_empty()
        || batch.targetCount == 0
        || batch.questions.is_empty()
        || batch.questions.len() > 8
    {
        return Err("Invalid question batch settings.".into());
    }
    let topics = note["topics"].as_array().ok_or("Invalid stored topics.")?;
    let topicIds: HashSet<_> = topics
        .iter()
        .filter_map(|topic| topic["id"].as_str())
        .collect();
    let allowed: HashSet<_> = batch.allowedTopicIds.iter().map(String::as_str).collect();
    if allowed.is_empty() || !allowed.is_subset(&topicIds) {
        return Err("The question batch references unknown topics.".into());
    }
    let savedCount = existing
        .iter()
        .filter(|q| {
            q["isBasicQuestion"] == true
                && q["generationScope"].as_str() == Some(&batch.scope)
                && q["difficulty"].as_u64() == Some(batch.difficulty as u64)
                && q["format"].as_u64() == Some(batch.format as u64)
        })
        .count();
    if batch.isBasicQuestion && savedCount + batch.questions.len() > batch.targetCount {
        return Err("The basic question target has already been filled.".into());
    }
    let mut texts: HashSet<_> = existing
        .iter()
        .filter_map(|q| q["text"].as_str())
        .map(normalized)
        .collect();
    for draft in &batch.questions {
        validate_draft(draft, batch, &allowed)?;
        if !texts.insert(normalized(&draft.text)) {
            return Err("A generated question duplicates an existing question.".into());
        }
    }
    for draft in &batch.questions {
        let questionId = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO questions (id, noteId, text, exampleAnswer, difficulty, format, choices, correctChoiceIndex, maxCharacters, answerCriteria, isBasicQuestion, generatedAt, generatedWithModel, generationScope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)")
            .bind(&questionId).bind(&batch.noteId).bind(&draft.text).bind(&draft.exampleAnswer)
            .bind(draft.difficulty as i64).bind(draft.format as i64)
            .bind(draft.choices.as_ref().map(|choices| json!(choices).to_string()))
            .bind(draft.correctChoiceIndex.map(|index| index as i64))
            .bind(draft.maxCharacters.map(i64::from)).bind(&draft.answerCriteria)
            .bind(batch.isBasicQuestion).bind(&batch.model).bind(&batch.scope)
            .execute(&mut *connection).await.map_err(storage_error)?;
        for topicId in &draft.topicIds {
            let broad = topics
                .iter()
                .any(|topic| topic["id"].as_str() == Some(topicId) && topic.get("text").is_none());
            let query = if broad {
                "INSERT INTO questionBroadTopics VALUES (?, ?)"
            } else {
                "INSERT INTO questionSubtopics VALUES (?, ?)"
            };
            sqlx::query(query)
                .bind(&questionId)
                .bind(topicId)
                .execute(&mut *connection)
                .await
                .map_err(storage_error)?;
        }
        if let Some(card) = &draft.fsrsData {
            sqlx::query("INSERT INTO questionFsrs VALUES (?, ?)")
                .bind(&questionId)
                .bind(card.to_string())
                .execute(&mut *connection)
                .await
                .map_err(storage_error)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_generated_questions(
    state: tauri::State<'_, NotesState>,
    folderPath: String,
    batch: QuestionBatch,
) -> Result<Value, String> {
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    persist_batch(&mut connection, &batch).await
}

async fn persist_batch(
    connection: &mut SqliteConnection,
    batch: &QuestionBatch,
) -> Result<Value, String> {
    // Reserve the writer before loading the note. A deferred read transaction
    // cannot wait when upgrading against a concurrent sync writer (SQLITE_BUSY).
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(storage_error)?;
    save_batch(&mut transaction, batch).await?;
    let note = load_note(&mut transaction, &batch.noteId).await?;
    transaction.commit().await.map_err(storage_error)?;
    Ok(note)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionAction {
    Remove,
    Reset,
}

async fn apply_question_action(
    connection: &mut SqliteConnection,
    noteId: &str,
    action: QuestionAction,
    expectedQuestionIds: &[String],
    fsrsData: Option<&Value>,
) -> Result<Value, String> {
    let note = load_note(connection, noteId).await?;
    let questions = note["questions"]
        .as_array()
        .ok_or("Invalid stored questions.")?;
    let currentIds: HashSet<_> = questions
        .iter()
        .filter_map(|question| question["id"].as_str())
        .collect();
    let expectedIds: HashSet<_> = expectedQuestionIds.iter().map(String::as_str).collect();
    if currentIds != expectedIds || expectedIds.len() != expectedQuestionIds.len() {
        return Err("This note's questions changed. Reopen the confirmation and try again.".into());
    }
    match action {
        QuestionAction::Remove => {
            if questions.is_empty() {
                return Err("This note has no questions to remove.".into());
            }
            sqlx::query("UPDATE questions SET isArchived = 1 WHERE noteId = ? AND isArchived = 0")
                .bind(noteId)
                .execute(&mut *connection)
                .await
                .map_err(storage_error)?;
            sqlx::query("DELETE FROM noteSyncIssues WHERE noteId = ? AND kind IN ('topicChanged', 'topicRemoved')")
                .bind(noteId).execute(&mut *connection).await.map_err(storage_error)?;
        }
        QuestionAction::Reset => {
            let card = fsrsData
                .filter(|card| validate_card(card))
                .ok_or("A schedule reset requires a new FSRS card.")?;
            let basicQuestions: Vec<_> = questions
                .iter()
                .filter(|question| question["isBasicQuestion"] == true)
                .collect();
            if basicQuestions.is_empty() {
                return Err("This note has no basic questions to reset.".into());
            }
            let resetIds: Vec<String> = basicQuestions
                .iter()
                .filter_map(|question| question["id"].as_str().map(str::to_string))
                .collect();
            for question in basicQuestions {
                let questionId = question["id"]
                    .as_str()
                    .ok_or("Invalid stored question ID.")?;
                sqlx::query("INSERT INTO questionFsrs (questionId, fsrsData) VALUES (?, ?) ON CONFLICT(questionId) DO UPDATE SET fsrsData = excluded.fsrsData")
                    .bind(questionId).bind(card.to_string()).execute(&mut *connection).await.map_err(storage_error)?;
            }
            let operation = json!({"id":uuid::Uuid::new_v4().to_string(),"questionIds":resetIds});
            sqlx::query("UPDATE cloudState SET document=json_set(document,'$.resetQueue',json_insert(COALESCE(json_extract(document,'$.resetQueue'),'[]'),'$[#]',json(?))),revision=revision+1 WHERE id=1").bind(operation.to_string()).execute(&mut *connection).await.map_err(storage_error)?;
        }
    }
    load_note(connection, noteId).await
}

#[tauri::command]
pub async fn manage_note_questions(
    state: tauri::State<'_, NotesState>,
    folderPath: String,
    noteId: String,
    action: QuestionAction,
    expectedQuestionIds: Vec<String>,
    fsrsData: Option<Value>,
) -> Result<Value, String> {
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(storage_error)?;
    let note = apply_question_action(
        &mut transaction,
        &noteId,
        action,
        &expectedQuestionIds,
        fsrsData.as_ref(),
    )
    .await?;
    transaction.commit().await.map_err(storage_error)?;
    Ok(note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    fn new_card() -> Value {
        json!({"due":"2026-10-25T10:00:00.000Z","stability":0,"difficulty":0,
            "elapsed_days":0,"scheduled_days":0,"learning_steps":0,"reps":0,"lapses":0,"state":0})
    }

    async fn fixture() -> (std::path::PathBuf, SqliteConnection, Value) {
        let root = std::env::temp_dir().join(format!("obstudy-questions-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let (mut connection, _) = crate::database::openDatabase(root.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query("INSERT INTO notes (id, filePath, text) VALUES ('note', '/vault/note.md', 'Source text')").execute(&mut connection).await.unwrap();
        sqlx::query(
            "INSERT INTO broadTopics (id, noteId, title) VALUES ('broad', 'note', 'Broad')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("INSERT INTO subtopics (id, noteId, broadTopicId, title, text) VALUES ('sub', 'note', 'broad', 'Subtopic', 'Source text')").execute(&mut connection).await.unwrap();
        let note = load_note(&mut connection, "note").await.unwrap();
        (root, connection, note)
    }

    fn batch(note: &Value, basic: bool) -> QuestionBatch {
        serde_json::from_value(json!({
            "noteId":"note", "sourceText":"Source text", "sourceTopics":note["topics"],
            "expectedQuestionIds":note["questions"].as_array().unwrap().iter().map(|q| q["id"].clone()).collect::<Vec<_>>(),
            "isBasicQuestion":basic, "scope":"easy:sub", "model":"selected-model", "difficulty":0,"format":1,"targetCount":3,
            "allowedTopicIds":["broad","sub"],
            "questions":[{"text":if basic {"Basic question?"} else {"Additional question?"},
                "exampleAnswer":"Answer", "topicIds":["sub","broad"],"difficulty":0,"format":1,
                "maxCharacters":500,"answerCriteria":"Explain the concept.",
                "fsrsData":if basic {new_card()} else {Value::Null}}]
        })).unwrap()
    }

    #[test]
    fn generation_waits_for_a_concurrent_sync_writer_and_preserves_both_changes() {
        tauri::async_runtime::block_on(async {
            let (root, mut sync_connection, note) = fixture().await;
            let (mut generation_connection, _) =
                crate::database::openDatabase(root.to_str().unwrap())
                    .await
                    .unwrap();
            let mut sync = sync_connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
            sqlx::query("UPDATE notes SET isStudying=1 WHERE id='note'")
                .execute(&mut *sync)
                .await
                .unwrap();
            let pending_batch = batch(&note, true);
            // Reproduce the old read-then-upgrade failure while sync owns the writer.
            let mut deferred = generation_connection.begin().await.unwrap();
            let lock_error = save_batch(&mut deferred, &pending_batch).await.unwrap_err();
            assert!(lock_error.contains("database is locked"), "{lock_error}");
            deferred.rollback().await.unwrap();
            // Separate file-backed connections reproduce a writer held by sync while
            // generation starts. No AI request or retry is needed to save this batch.
            let (saved, ()) = tokio::join!(
                persist_batch(&mut generation_connection, &pending_batch),
                async {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    sync.commit().await.unwrap();
                }
            );
            let saved = saved.unwrap();
            assert_eq!(saved["isStudying"], true);
            assert_eq!(saved["questions"].as_array().unwrap().len(), 1);
            assert_eq!(saved["questionFsrs"].as_array().unwrap().len(), 1);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM questions")
                    .fetch_one(&mut generation_connection)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM questionFsrs")
                    .fetch_one(&mut generation_connection)
                    .await
                    .unwrap(),
                1
            );
            // Optimistic validation still rejects a stale retry without duplicating data,
            // and a subsequent valid batch can write after that rollback.
            assert!(
                persist_batch(&mut generation_connection, &pending_batch)
                    .await
                    .unwrap_err()
                    .contains("changed during generation")
            );
            let second = persist_batch(&mut generation_connection, &batch(&saved, false))
                .await
                .unwrap();
            assert_eq!(second["questions"].as_array().unwrap().len(), 2);
            assert_eq!(second["questionFsrs"].as_array().unwrap().len(), 1);
            generation_connection.close().await.unwrap();
            sync_connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    async fn seed_history(connection: &mut SqliteConnection, note: &Value) {
        sqlx::raw_sql("INSERT INTO practiceSettings (id, noteId, questionCount, difficulty, reuseQuestions, questionFormat) VALUES ('settings', 'note', 1, 0, 1, 1); INSERT INTO exercises (id, noteId, settingsId, mode, maxPoints) VALUES ('exercise', 'note', 'settings', 'study', 10);")
            .execute(&mut *connection).await.unwrap();
        sqlx::query("INSERT INTO exerciseQuestions (exerciseId, questionId, position, questionSnapshot) VALUES ('exercise', ?, 0, ?)")
            .bind(note["questions"][0]["id"].as_str().unwrap()).bind(note["questions"][0].to_string()).execute(&mut *connection).await.unwrap();
        sqlx::raw_sql("INSERT INTO performances (id, exerciseId, completedAt, totalPoints) VALUES ('performance', 'exercise', '2026-10-24T10:00:00.000Z', 8);")
            .execute(&mut *connection).await.unwrap();
        sqlx::query("INSERT INTO answers (id, performanceId, questionId, answeredAt, text, points, feedback, position) VALUES ('answer', 'performance', ?, '2026-10-24T10:00:00.000Z', 'My answer', 8, 'Feedback', 0)")
            .bind(note["questions"][0]["id"].as_str().unwrap()).execute(&mut *connection).await.unwrap();
    }

    fn current_ids(note: &Value) -> Vec<String> {
        note["questions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|question| question["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn removal_archives_only_selected_note_and_preserves_answers_results_and_snapshots() {
        tauri::async_runtime::block_on(async {
            let (root, mut connection, initial) = fixture().await;
            save_batch(&mut connection, &batch(&initial, true))
                .await
                .unwrap();
            let basic = load_note(&mut connection, "note").await.unwrap();
            save_batch(&mut connection, &batch(&basic, false))
                .await
                .unwrap();
            let saved = load_note(&mut connection, "note").await.unwrap();
            seed_history(&mut connection, &saved).await;
            sqlx::raw_sql("INSERT INTO notes (id, filePath) VALUES ('other', '/vault/other.md'); INSERT INTO questions (id, noteId, text, exampleAnswer, difficulty, format, maxCharacters, answerCriteria) VALUES ('other-question', 'other', 'Other?', 'Other', 0, 1, 500, 'Criteria');").execute(&mut connection).await.unwrap();
            let before = load_note(&mut connection, "note").await.unwrap();
            let mut transaction = connection.begin().await.unwrap();
            let removed = apply_question_action(
                &mut transaction,
                "note",
                QuestionAction::Remove,
                &current_ids(&before),
                None,
            )
            .await
            .unwrap();
            transaction.commit().await.unwrap();
            assert!(removed["questions"].as_array().unwrap().is_empty());
            assert!(removed["questionFsrs"].as_array().unwrap().is_empty());
            for field in ["answers", "performances", "exercises", "topics"] {
                assert_eq!(removed[field], before[field]);
            }
            let archived: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM questions WHERE noteId = 'note' AND isArchived = 1",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(archived, 2);
            assert_eq!(
                load_note(&mut connection, "other").await.unwrap()["questions"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            connection.close().await.unwrap();
            let (mut reopened, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            let persisted = load_note(&mut reopened, "note").await.unwrap();
            assert!(persisted["questions"].as_array().unwrap().is_empty());
            assert_eq!(persisted["answers"], before["answers"]);
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn resetting_only_active_basic_cards_keeps_questions_history_and_archived_cards() {
        tauri::async_runtime::block_on(async {
            let (root, mut connection, initial) = fixture().await;
            save_batch(&mut connection, &batch(&initial, true))
                .await
                .unwrap();
            let basic = load_note(&mut connection, "note").await.unwrap();
            save_batch(&mut connection, &batch(&basic, false))
                .await
                .unwrap();
            let mut archivedBatch = batch(&load_note(&mut connection, "note").await.unwrap(), true);
            archivedBatch.questions[0].text = "Archived question?".into();
            save_batch(&mut connection, &archivedBatch).await.unwrap();
            sqlx::query("UPDATE questions SET isArchived = 1 WHERE text = 'Archived question?'")
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::query(
                "UPDATE questionFsrs SET fsrsData = json_set(fsrsData, '$.reps', 6, '$.state', 2)",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            let saved = load_note(&mut connection, "note").await.unwrap();
            seed_history(&mut connection, &saved).await;
            let before = load_note(&mut connection, "note").await.unwrap();
            let reset = apply_question_action(
                &mut connection,
                "note",
                QuestionAction::Reset,
                &current_ids(&before),
                Some(&new_card()),
            )
            .await
            .unwrap();
            for field in ["questions", "answers", "performances", "exercises"] {
                assert_eq!(reset[field], before[field]);
            }
            assert_eq!(reset["questionFsrs"].as_array().unwrap().len(), 1);
            assert_eq!(reset["questionFsrs"][0]["fsrsData"], new_card());
            let archived: String = sqlx::query_scalar("SELECT fsrsData FROM questionFsrs f JOIN questions q ON q.id=f.questionId WHERE q.isArchived = 1").fetch_one(&mut connection).await.unwrap();
            assert_eq!(serde_json::from_str::<Value>(&archived).unwrap()["reps"], 6);
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn maintenance_rejects_stale_confirmation_and_invalid_reset_before_changes() {
        tauri::async_runtime::block_on(async {
            let (root, mut connection, initial) = fixture().await;
            save_batch(&mut connection, &batch(&initial, true))
                .await
                .unwrap();
            let before = load_note(&mut connection, "note").await.unwrap();
            assert!(
                apply_question_action(&mut connection, "note", QuestionAction::Remove, &[], None)
                    .await
                    .is_err()
            );
            assert!(
                apply_question_action(
                    &mut connection,
                    "note",
                    QuestionAction::Reset,
                    &current_ids(&before),
                    Some(&json!({}))
                )
                .await
                .is_err()
            );
            assert_eq!(load_note(&mut connection, "note").await.unwrap(), before);
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn basic_and_additional_questions_survive_reopen_with_only_basic_cards() {
        tauri::async_runtime::block_on(async {
            let (root, mut connection, note) = fixture().await;
            let mut transaction = connection.begin().await.unwrap();
            save_batch(&mut transaction, &batch(&note, true))
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            let basic = load_note(&mut connection, "note").await.unwrap();
            assert_eq!(basic["questions"][0]["isBasicQuestion"], true);
            assert_eq!(
                basic["questions"][0]["generatedWithModel"],
                "selected-model"
            );
            assert!(
                basic["questions"][0]["generatedAt"]
                    .as_str()
                    .unwrap()
                    .ends_with('Z')
            );
            assert_eq!(basic["questionFsrs"].as_array().unwrap().len(), 1);
            let mut transaction = connection.begin().await.unwrap();
            save_batch(&mut transaction, &batch(&basic, false))
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            connection.close().await.unwrap();
            let (mut reopened, _) = crate::database::openDatabase(root.to_str().unwrap())
                .await
                .unwrap();
            let saved = load_note(&mut reopened, "note").await.unwrap();
            assert_eq!(saved["questions"].as_array().unwrap().len(), 2);
            assert_eq!(saved["questions"][1]["isBasicQuestion"], false);
            assert_eq!(saved["questionFsrs"].as_array().unwrap().len(), 1);
            let additionalId = saved["questions"][1]["id"].as_str().unwrap();
            assert!(
                sqlx::query("INSERT INTO questionFsrs VALUES (?, '{}')")
                    .bind(additionalId)
                    .execute(&mut reopened)
                    .await
                    .is_err()
            );
            let basicId = saved["questions"][0]["id"].as_str().unwrap();
            assert!(
                sqlx::query("UPDATE questionFsrs SET questionId = ? WHERE questionId = ?")
                    .bind(additionalId)
                    .bind(basicId)
                    .execute(&mut reopened)
                    .await
                    .is_err()
            );
            assert!(
                sqlx::query("UPDATE questions SET isBasicQuestion = 0 WHERE id = ?")
                    .bind(basicId)
                    .execute(&mut reopened)
                    .await
                    .is_err()
            );
            sqlx::query("UPDATE questions SET isArchived = 1 WHERE id = ?")
                .bind(basicId)
                .execute(&mut reopened)
                .await
                .unwrap();
            let archived = load_note(&mut reopened, "note").await.unwrap();
            assert!(archived["questionFsrs"].as_array().unwrap().is_empty());
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn invalid_cards_topics_duplicates_and_stale_snapshots_cannot_be_saved() {
        tauri::async_runtime::block_on(async {
            let (root, mut connection, note) = fixture().await;
            let mut invalid = batch(&note, true);
            invalid.questions[0].fsrsData = None;
            assert!(save_batch(&mut connection, &invalid).await.is_err());
            let mut invalid = batch(&note, false);
            invalid.questions[0].fsrsData = Some(new_card());
            assert!(save_batch(&mut connection, &invalid).await.is_err());
            let mut invalid = batch(&note, true);
            invalid.questions[0].topicIds = vec!["foreign".into()];
            assert!(save_batch(&mut connection, &invalid).await.is_err());
            let mut invalid = batch(&note, true);
            invalid.questions[0].fsrsData.as_mut().unwrap()["reps"] = json!(1);
            assert!(save_batch(&mut connection, &invalid).await.is_err());
            let mut invalid = batch(&note, true);
            invalid.sourceText = "Outdated source".into();
            assert!(save_batch(&mut connection, &invalid).await.is_err());
            let mut transaction = connection.begin().await.unwrap();
            save_batch(&mut transaction, &batch(&note, true))
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            // Simulates a second simultaneous generation trying to save from the same initial snapshot.
            assert!(
                save_batch(&mut connection, &batch(&note, true))
                    .await
                    .is_err()
            );
            let saved = load_note(&mut connection, "note").await.unwrap();
            // A fresh snapshot still rejects duplicated question text.
            assert!(
                save_batch(&mut connection, &batch(&saved, true))
                    .await
                    .is_err()
            );
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM questions")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(count, 1);
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn failed_card_insert_rolls_back_the_question_and_all_topic_links() {
        tauri::async_runtime::block_on(async {
            let (root, mut connection, note) = fixture().await;
            sqlx::raw_sql("CREATE TRIGGER simulatedFailure BEFORE INSERT ON questionFsrs BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END;").execute(&mut connection).await.unwrap();
            let mut transaction = connection.begin().await.unwrap();
            assert!(
                save_batch(&mut transaction, &batch(&note, true))
                    .await
                    .is_err()
            );
            transaction.rollback().await.unwrap();
            let row = sqlx::query("SELECT (SELECT COUNT(*) FROM questions) AS questions, (SELECT COUNT(*) FROM questionSubtopics) AS subtopics, (SELECT COUNT(*) FROM questionBroadTopics) AS broadTopics").fetch_one(&mut connection).await.unwrap();
            assert_eq!(row.get::<i64, _>("questions"), 0);
            assert_eq!(row.get::<i64, _>("subtopics"), 0);
            assert_eq!(row.get::<i64, _>("broadTopics"), 0);
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn upgrade_preserves_legacy_cards_and_marks_only_scheduled_questions_basic() {
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/0002_note_sync.sql"))
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::query("INSERT INTO notes (id, filePath) VALUES ('note', 'note.md')")
                .execute(&mut connection)
                .await
                .unwrap();
            for questionId in ["scheduled", "extra"] {
                sqlx::query("INSERT INTO questions (id, noteId, text, exampleAnswer, difficulty, format, maxCharacters, answerCriteria) VALUES (?, 'note', 'Q', 'A', 0, 1, 500, 'Criteria')").bind(questionId).execute(&mut connection).await.unwrap();
            }
            sqlx::query("INSERT INTO questionFsrs VALUES ('scheduled', '{}')")
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/0003_question_generation.sql"))
                .execute(&mut connection)
                .await
                .unwrap();
            let flags: Vec<(String, bool)> =
                sqlx::query_as("SELECT id, isBasicQuestion FROM questions ORDER BY id")
                    .fetch_all(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(
                flags,
                vec![("extra".into(), false), ("scheduled".into(), true)]
            );
            let cards: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM questionFsrs")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(cards, 1);
        });
    }
    #[test]
    fn connected_resets_queue_an_operation_and_reject_stale_sync_commits() {
        tauri::async_runtime::block_on(async {
            let (root, mut connection, initial) = fixture().await;
            save_batch(&mut connection, &batch(&initial, true))
                .await
                .unwrap();
            let saved = load_note(&mut connection, "note").await.unwrap();
            let state = json!({"schemaVersion":1,"knownAnswerIds":[]});
            sqlx::query("INSERT INTO cloudState(id,userId,serverUrl,revision,document) VALUES (1,'account','https://api.example.com',1,?)").bind(state.to_string()).execute(&mut connection).await.unwrap();
            apply_question_action(
                &mut connection,
                "note",
                QuestionAction::Reset,
                &current_ids(&saved),
                Some(&new_card()),
            )
            .await
            .unwrap();
            let row = sqlx::query("SELECT revision,document FROM cloudState WHERE id=1")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(row.get::<i64, _>("revision"), 2);
            let cached: Value = serde_json::from_str(&row.get::<String, _>("document")).unwrap();
            assert_eq!(
                cached["resetQueue"][0]["questionIds"][0],
                saved["questions"][0]["id"]
            );
            assert!(
                crate::cloud_desktop::cloud_desktop_commit(
                    root.to_str().unwrap().into(),
                    "account".into(),
                    "https://api.example.com".into(),
                    1,
                    state,
                    None,
                    vec![]
                )
                .await
                .is_err()
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        });
    }
}
