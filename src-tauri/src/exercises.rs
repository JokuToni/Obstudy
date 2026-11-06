#![allow(non_snake_case)]

use crate::notes::{NotesState, snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Connection, Row, SqliteConnection};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

#[derive(Default)]
pub struct PracticeWindows(Mutex<HashMap<String, String>>);

#[derive(Clone, Deserialize)]
pub struct PracticeSettings {
    questionCount: u32,
    difficulty: u8,
    #[serde(default)]
    difficulties: Option<Vec<u8>>,
    reuseQuestions: bool,
    questionFormat: u8,
    topicIds: Vec<String>,
    #[serde(default)]
    excludeAllTopics: bool,
}
#[derive(Deserialize)]
pub struct ExerciseRequest {
    noteId: String,
    mode: String,
    settings: PracticeSettings,
    questionIds: Vec<String>,
    sourceText: String,
    dueBefore: String,
    dueAfter: String,
    warnings: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnswerGrade {
    points: f64,
    source: String,
    feedback: String,
    model: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftAnswer {
    questionId: String,
    text: String,
    selectedChoiceIndex: Option<usize>,
    revealed: bool,
    grade: Option<AnswerGrade>,
    drawing: Option<Value>,
    #[serde(default)]
    editorMode: Option<String>,
}

fn validate_drawing(drawing: &Option<Value>) -> Result<Value, String> {
    let Some(drawing) = drawing else {
        return Ok(Value::Null);
    };
    let elements = drawing["elements"]
        .as_array()
        .ok_or("Invalid drawing elements.")?;
    if drawing["version"] != 1
        || drawing["width"] != 1200
        || drawing["height"] != 800
        || elements.len() > 2000
        || drawing.to_string().len() > 2_000_000
    {
        return Err("Invalid drawing size or version.".into());
    }
    for element in elements {
        if !matches!(
            element["type"].as_str(),
            Some("rectangle" | "diamond" | "ellipse" | "line" | "arrow" | "freedraw" | "text")
        ) || !element["link"].is_null()
            || !["x", "y", "width", "height", "angle"].iter().all(|key| {
                element[*key]
                    .as_f64()
                    .is_some_and(|number| number.is_finite() && number.abs() <= 10000.0)
            })
        {
            return Err("Invalid drawing element.".into());
        }
        if let Some(points) = element["points"].as_array() {
            if points.len() > 50000
                || points.iter().any(|point| {
                    point.as_array().is_none_or(|pair| {
                        pair.len() != 2
                            || pair.iter().any(|value| {
                                value.as_f64().is_none_or(|number| {
                                    !number.is_finite() || number.abs() > 10000.0
                                })
                            })
                    })
                })
            {
                return Err("Invalid drawing points.".into());
            }
        }
    }
    Ok(drawing.clone())
}
fn has_drawing(drawing: &Value) -> bool {
    drawing["elements"]
        .as_array()
        .is_some_and(|elements| elements.iter().any(|element| element["isDeleted"] != true))
}
fn db_error(error: sqlx::Error) -> String {
    format!("Unable to save the practice session: {error}")
}
fn id() -> String {
    Uuid::new_v4().to_string()
}

async fn insert_settings(
    connection: &mut SqliteConnection,
    note: &Value,
    settings: &PracticeSettings,
) -> Result<String, String> {
    let levels = settings
        .difficulties
        .clone()
        .unwrap_or_else(|| vec![settings.difficulty]);
    if levels.is_empty()
        || levels.iter().any(|level| *level > 2)
        || levels.iter().collect::<HashSet<_>>().len() != levels.len()
    {
        return Err("Select at least one valid difficulty.".into());
    }
    if !(1..=1000).contains(&settings.questionCount)
        || settings.difficulty > 2
        || settings.questionFormat > 2
    {
        return Err("Choose valid practice settings and between 1 and 1000 questions.".into());
    }
    let topics = note["topics"].as_array().ok_or("Invalid saved topics.")?;
    let ids: HashSet<_> = settings.topicIds.iter().collect();
    if ids.len() != settings.topicIds.len()
        || ids.iter().any(|id| {
            !topics
                .iter()
                .any(|topic| topic["id"].as_str() == Some(id.as_str()))
        })
    {
        return Err("A selected topic no longer belongs to this note.".into());
    }
    let settingsId = id();
    sqlx::query("INSERT INTO practiceSettings (id,noteId,questionCount,difficulty,reuseQuestions,questionFormat) VALUES (?,?,?,?,?,?)")
        .bind(&settingsId).bind(note["id"].as_str()).bind(i64::from(settings.questionCount)).bind(i64::from(settings.difficulty))
        .bind(settings.reuseQuestions).bind(i64::from(settings.questionFormat)).execute(&mut *connection).await.map_err(db_error)?;
    sqlx::query(
        "UPDATE practiceSettings SET difficulty=?,difficulties=?,excludeAllTopics=? WHERE id=?",
    )
    .bind(i64::from(levels[0]))
    .bind(json!(levels).to_string())
    .bind(settings.excludeAllTopics)
    .bind(&settingsId)
    .execute(&mut *connection)
    .await
    .map_err(db_error)?;
    for topicId in &settings.topicIds {
        let broad = topics
            .iter()
            .any(|topic| topic["id"].as_str() == Some(topicId) && topic.get("text").is_none());
        let query = if broad {
            "INSERT INTO settingsBroadTopics VALUES (?,?)"
        } else {
            "INSERT INTO settingsSubtopics VALUES (?,?)"
        };
        sqlx::query(query)
            .bind(&settingsId)
            .bind(topicId)
            .execute(&mut *connection)
            .await
            .map_err(db_error)?;
    }
    Ok(settingsId)
}

#[tauri::command]
pub async fn save_practice_settings(
    state: tauri::State<'_, NotesState>,
    folderPath: String,
    noteId: String,
    settings: PracticeSettings,
) -> Result<Value, String> {
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    let mut transaction = connection.begin().await.map_err(db_error)?;
    let note = snapshot::load_note(&mut transaction, &noteId).await?;
    let settingsId = insert_settings(&mut transaction, &note, &settings).await?;
    sqlx::query("INSERT INTO noteSettings (noteId,settingsId) VALUES (?,?) ON CONFLICT(noteId) DO UPDATE SET settingsId=excluded.settingsId")
        .bind(&noteId).bind(settingsId).execute(&mut *transaction).await.map_err(db_error)?;
    let note = snapshot::load_note(&mut transaction, &noteId).await?;
    transaction.commit().await.map_err(db_error)?;
    Ok(note)
}

async fn load_session(
    connection: &mut SqliteConnection,
    exerciseId: &str,
) -> Result<Value, String> {
    let row = sqlx::query("SELECT * FROM exercises WHERE id=?")
        .bind(exerciseId)
        .fetch_optional(&mut *connection)
        .await
        .map_err(db_error)?
        .ok_or("This practice session no longer exists.")?;
    let settings = snapshot::settings(connection, &row.get::<String, _>("settingsId")).await?;
    let snapshots: Vec<String> = sqlx::query_scalar(
        "SELECT questionSnapshot FROM exerciseQuestions WHERE exerciseId=? ORDER BY position",
    )
    .bind(exerciseId)
    .fetch_all(&mut *connection)
    .await
    .map_err(db_error)?;
    let parse = |text: &str| {
        serde_json::from_str::<Value>(text).map_err(|_| "Saved session data is invalid.".to_owned())
    };
    let questions: Vec<Value> = snapshots
        .iter()
        .map(|snapshot| parse(snapshot))
        .collect::<Result<_, _>>()?;
    let mut drafts = parse(&row.get::<String, _>("draftAnswers"))?;
    for draft in drafts.as_array_mut().ok_or("Invalid saved drafts.")? {
        if let Some(grade) = sqlx::query("SELECT points,feedback,gradingSource,gradingModel FROM submittedAnswers WHERE exerciseId=? AND questionId=? AND points IS NOT NULL")
            .bind(exerciseId).bind(draft["questionId"].as_str()).fetch_optional(&mut *connection).await.map_err(db_error)? {
            draft["grade"] = json!({"points":grade.get::<f64,_>("points"),"feedback":grade.get::<String,_>("feedback"),"source":grade.get::<Option<String>,_>("gradingSource").unwrap_or("self".into()),"model":grade.get::<Option<String>,_>("gradingModel")});
        }
    }
    Ok(
        json!({"id":exerciseId,"noteId":row.get::<String,_>("noteId"),"mode":row.get::<String,_>("mode"),"settings":settings,
        "maxPoints":row.get::<f64,_>("maxPoints"),"questions":questions,"noteTitle":row.get::<String,_>("noteTitle"),
        "createdAt":row.get::<Option<String>,_>("createdAt"),"reviewedAt":row.get::<Option<String>,_>("reviewedAt"),
        "closedAt":row.get::<Option<String>,_>("closedAt"),"revision":row.get::<i64,_>("draftRevision"),"draftAnswers":drafts,"warnings":parse(&row.get::<String,_>("warnings"))?}),
    )
}

async fn persist_exercise(
    connection: &mut SqliteConnection,
    request: &ExerciseRequest,
) -> Result<Value, String> {
    if !matches!(request.mode.as_str(), "study" | "practice") {
        return Err("Invalid session mode.".into());
    }
    let note = snapshot::load_note(connection, &request.noteId).await?;
    if note["isAvailable"] != true
        || !note["parseError"].is_null()
        || note["syncIssues"]
            .as_array()
            .is_none_or(|issues| !issues.is_empty())
    {
        return Err(
            "Resolve note errors and pending topic changes before starting a session.".into(),
        );
    }
    if note["file"]["text"].as_str() != Some(&request.sourceText) {
        return Err("The note changed while preparing this session. Try again.".into());
    }
    if request.questionIds.is_empty()
        || request.questionIds.len() > request.settings.questionCount as usize
        || request.questionIds.iter().collect::<HashSet<_>>().len() != request.questionIds.len()
    {
        return Err(
            "The session must contain unique saved questions within the requested count.".into(),
        );
    }
    if request.settings.excludeAllTopics {
        return Err("Include at least one topic before starting a session.".into());
    }
    let mut selectedTopics: HashSet<String> = request.settings.topicIds.iter().cloned().collect();
    for topic in note["topics"].as_array().ok_or("Invalid topics.")? {
        if topic["broadTopicId"]
            .as_str()
            .is_some_and(|parent| selectedTopics.contains(parent))
        {
            selectedTopics.insert(topic["id"].as_str().ok_or("Invalid topic ID.")?.into());
        }
    }
    let mut questions = Vec::new();
    if request.mode == "study" {
        let dueIds: Vec<String> = sqlx::query_scalar("SELECT q.id FROM questions q JOIN questionFsrs f ON f.questionId=q.id WHERE q.noteId=? AND q.isArchived=0 AND q.isBasicQuestion=1 AND julianday(json_extract(f.fsrsData,'$.due')) < julianday(?) AND NOT EXISTS (SELECT 1 FROM answerHistory h WHERE h.questionId=q.id AND h.mode='study' AND julianday(h.answeredAt)>=julianday(?) AND julianday(h.answeredAt)<julianday(?)) ORDER BY julianday(json_extract(f.fsrsData,'$.due')), q.id")
            .bind(&request.noteId).bind(&request.dueBefore).bind(&request.dueAfter).bind(&request.dueBefore).fetch_all(&mut *connection).await.map_err(db_error)?;
        let matchingIds: HashSet<&str> = note["questions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|question| {
                selectedTopics.is_empty()
                    || question["topicIds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|topic| topic.as_str().is_some_and(|id| selectedTopics.contains(id)))
            })
            .filter_map(|question| question["id"].as_str())
            .collect();
        let dueIds: Vec<String> = dueIds
            .into_iter()
            .filter(|questionId| matchingIds.contains(questionId.as_str()))
            .take(request.settings.questionCount as usize)
            .collect();
        if dueIds != request.questionIds {
            return Err("The study schedule changed. Prepare the session again.".into());
        }
    }
    for questionId in &request.questionIds {
        let question = note["questions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|question| question["id"].as_str() == Some(questionId))
            .ok_or("A selected question was removed. Prepare the session again.")?;
        if request.mode == "study" {
            let due: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM questionFsrs f JOIN questions q ON q.id=f.questionId WHERE q.id=? AND q.isBasicQuestion=1 AND q.isArchived=0 AND julianday(json_extract(f.fsrsData,'$.due')) < julianday(?))")
                .bind(questionId).bind(&request.dueBefore).fetch_one(&mut *connection).await.map_err(db_error)?;
            if !due {
                return Err(
                    "A selected study question is no longer due. Prepare the session again.".into(),
                );
            }
        } else if !request
            .settings
            .difficulties
            .clone()
            .unwrap_or_else(|| vec![request.settings.difficulty])
            .iter()
            .any(|level| question["difficulty"].as_u64() == Some(u64::from(*level)))
            || request.settings.questionFormat < 2
                && question["format"].as_u64() != Some(request.settings.questionFormat as u64)
            || !selectedTopics.is_empty()
                && !question["topicIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|topic| topic.as_str().is_some_and(|id| selectedTopics.contains(id)))
        {
            return Err("A selected question does not match the practice settings.".into());
        }
        if request.mode == "practice"
            && !request.settings.reuseQuestions
            && question["isBasicQuestion"] != false
        {
            return Err("Fresh practice sessions require additional questions.".into());
        }
        questions.push(question.clone());
    }
    let settingsId = insert_settings(connection, &note, &request.settings).await?;
    let exerciseId = id();
    let noteTitle = std::path::Path::new(note["file"]["path"].as_str().unwrap_or("Note"))
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Note");
    sqlx::query("INSERT INTO exercises (id,noteId,settingsId,mode,maxPoints,noteTitle,createdAt,warnings) VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)")
        .bind(&exerciseId).bind(&request.noteId).bind(settingsId).bind(&request.mode).bind(questions.len() as f64).bind(noteTitle).bind(json!(request.warnings).to_string()).execute(&mut *connection).await.map_err(db_error)?;
    for (position, question) in questions.iter().enumerate() {
        sqlx::query("INSERT INTO exerciseQuestions (exerciseId,questionId,position,questionSnapshot) VALUES (?,?,?,?)")
            .bind(&exerciseId).bind(question["id"].as_str()).bind(position as i64).bind(question.to_string()).execute(&mut *connection).await.map_err(db_error)?;
    }
    load_session(connection, &exerciseId).await
}

#[tauri::command]
pub async fn create_exercise(
    state: tauri::State<'_, NotesState>,
    folderPath: String,
    request: ExerciseRequest,
) -> Result<Value, String> {
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    let mut transaction = connection.begin().await.map_err(db_error)?;
    let exercise = persist_exercise(&mut transaction, &request).await?;
    transaction.commit().await.map_err(db_error)?;
    Ok(exercise)
}

#[tauri::command]
pub async fn open_practice_window(
    app: tauri::AppHandle,
    folderPath: String,
    exerciseId: String,
) -> Result<String, String> {
    Uuid::parse_str(&exerciseId).map_err(|_| "Invalid session ID.")?;
    let label = format!("practice-{exerciseId}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(label);
    }
    let (mut connection, _) = crate::database::openDatabase(&folderPath).await?;
    let session = load_session(&mut connection, &exerciseId).await?;
    let mut width: f64 = 860.0;
    let mut height: f64 = 780.0;
    if let Some(monitor) = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
    {
        let screenWidth = monitor.size().width as f64 / monitor.scale_factor();
        let screenHeight = monitor.size().height as f64 / monitor.scale_factor();
        width = (screenWidth * 0.58)
            .min(960.0)
            .min(screenWidth - 48.0)
            .max(420.0);
        height = (screenHeight * 0.86).min(screenHeight - 48.0).max(420.0);
    }
    {
        let contexts = app.state::<PracticeWindows>();
        let mut contexts = contexts
            .0
            .lock()
            .map_err(|_| "Unable to prepare the session window.")?;
        if contexts.contains_key(&label) {
            return Err("This session window is already opening. Try again shortly.".into());
        }
        contexts.insert(label.clone(), folderPath);
    }
    let result = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("?practice={exerciseId}").into()),
    )
    .title(format!(
        "Obstudy — {}",
        session["noteTitle"].as_str().unwrap_or("Practice")
    ))
    .inner_size(width, height)
    .min_inner_size(420.0, 420.0)
    .center()
    .visible(false)
    .background_color(tauri::window::Color(20, 20, 20, 255))
    .disable_drag_drop_handler()
    .build();
    match result {
        Ok(window) => {
            let handle = app.clone();
            let windowLabel = label.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Ok(mut contexts) = handle.state::<PracticeWindows>().0.lock() {
                        contexts.remove(&windowLabel);
                    }
                }
            });
            Ok(label)
        }
        Err(error) => {
            app.state::<PracticeWindows>()
                .0
                .lock()
                .map_err(|_| "Unable to prepare the session window.")?
                .remove(&label);
            Err(format!("Unable to open the practice window: {error}"))
        }
    }
}

fn session_folder(
    window: &tauri::WebviewWindow,
    app: &tauri::AppHandle,
    exerciseId: &str,
) -> Result<String, String> {
    if window.label() != format!("practice-{exerciseId}") {
        return Err("This session belongs to another window.".into());
    }
    app.state::<PracticeWindows>()
        .0
        .lock()
        .map_err(|_| "Unable to access the session window.")?
        .get(window.label())
        .cloned()
        .ok_or("The session window is no longer registered.".into())
}

#[tauri::command]
pub async fn load_exercise_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    exerciseId: String,
) -> Result<Value, String> {
    let folder = session_folder(&window, &app, &exerciseId)?;
    let (mut connection, _) = crate::database::openDatabase(&folder).await?;
    load_session(&mut connection, &exerciseId).await
}

async fn save_draft(
    connection: &mut SqliteConnection,
    exerciseId: &str,
    expectedRevision: i64,
    answers: &[DraftAnswer],
    finish: bool,
) -> Result<Value, String> {
    let session = load_session(connection, exerciseId).await?;
    if session["revision"].as_i64() != Some(expectedRevision) {
        return Err("This session was updated elsewhere. Reload it before continuing.".into());
    }
    if !session["closedAt"].is_null() {
        return Err("This session is closed.".into());
    }
    let questions = session["questions"]
        .as_array()
        .ok_or("Invalid session questions.")?;
    let previous = session["draftAnswers"]
        .as_array()
        .ok_or("Invalid saved answers.")?;
    let mut ids = HashSet::new();
    let mut normalized = Vec::new();
    for answer in answers {
        if !ids.insert(&answer.questionId) {
            return Err("Duplicate draft answer.".into());
        }
        let question = questions
            .iter()
            .find(|question| question["id"].as_str() == Some(&answer.questionId))
            .ok_or("An answer does not belong to this session.")?;
        let drawing = validate_drawing(&answer.drawing)?;
        if question["format"] == 0 && !drawing.is_null() {
            return Err("Multiple-choice answers cannot contain drawings.".into());
        }
        let editorMode = answer.editorMode.as_deref().unwrap_or("text");
        if !matches!(editorMode, "text" | "draw") {
            return Err("Invalid answer editor mode.".into());
        }
        let text = if question["format"] == 0 {
            match answer.selectedChoiceIndex {
                Some(index) => question["choices"]
                    .as_array()
                    .and_then(|choices| choices.get(index))
                    .and_then(Value::as_str)
                    .ok_or("Invalid selected choice.")?
                    .to_owned(),
                None => String::new(),
            }
        } else {
            if answer.selectedChoiceIndex.is_some()
                || answer.text.chars().count()
                    > question["maxCharacters"].as_u64().unwrap_or(0) as usize
            {
                return Err(
                    "The answer exceeds its character limit or has an invalid choice.".into(),
                );
            }
            answer.text.clone()
        };
        if answer.revealed && text.trim().is_empty() && !has_drawing(&drawing) {
            return Err("Enter an answer before revealing the example answer.".into());
        }
        let grade = if !answer.revealed {
            if answer.grade.is_some() {
                return Err("Submit the answer before grading it.".into());
            }
            Value::Null
        } else if question["format"] == 0 {
            json!({"points":if answer.selectedChoiceIndex.map(|index| index as u64)==question["correctChoiceIndex"].as_u64() {1.0} else {0.0},"source":"automatic","feedback":"","model":null})
        } else if let Some(grade) = &answer.grade {
            if ![0.0, 0.5, 1.0].contains(&grade.points)
                || !matches!(grade.source.as_str(), "self" | "ai")
                || grade.feedback.chars().count() > 4000
                || grade.model.as_ref().is_some_and(|model| model.len() > 200)
            {
                return Err("Invalid freeform grade. Use 0, 0.5, or 1.".into());
            }
            serde_json::to_value(grade).map_err(|_| "Invalid grade.")?
        } else {
            Value::Null
        };
        let value = json!({"questionId":answer.questionId,"text":text,"selectedChoiceIndex":answer.selectedChoiceIndex,"revealed":answer.revealed,"grade":grade,"drawing":drawing,"editorMode":editorMode});
        if let Some(saved) = previous
            .iter()
            .find(|saved| saved["questionId"] == answer.questionId && saved["revealed"] == true)
        {
            if ["text", "selectedChoiceIndex", "revealed", "drawing"]
                .iter()
                .any(|key| saved[*key] != value[*key])
            {
                return Err(
                    "Submitted answers cannot be changed after revealing the example answer."
                        .into(),
                );
            }
        }
        normalized.push(value);
    }
    if previous.iter().any(|saved| {
        saved["revealed"] == true
            && !normalized
                .iter()
                .any(|answer| answer["questionId"] == saved["questionId"])
    }) {
        return Err("Submitted answers cannot be removed.".into());
    }
    if finish && (answers.len() != questions.len() || answers.iter().any(|answer| !answer.revealed))
    {
        return Err("Answer every question before reviewing the completed session.".into());
    }
    let mut newSubmissions = 0u64;
    for answer in &normalized {
        if answer["revealed"] != true || answer["grade"].is_null() {
            continue;
        }
        let grade = &answer["grade"];
        if previous
            .iter()
            .any(|saved| saved["questionId"] == answer["questionId"] && saved["grade"] == *grade)
        {
            continue;
        }
        sqlx::query("INSERT INTO submittedAnswers (id,exerciseId,questionId,answeredAt,text,selectedChoiceIndex,points,feedback,gradingSource,gradingModel,gradedAt,drawing) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?) ON CONFLICT(exerciseId,questionId) DO UPDATE SET points=excluded.points,feedback=excluded.feedback,gradingSource=excluded.gradingSource,gradingModel=excluded.gradingModel,gradedAt=excluded.gradedAt")
            .bind(id()).bind(exerciseId).bind(answer["questionId"].as_str()).bind(answer["text"].as_str()).bind(answer["selectedChoiceIndex"].as_i64())
            .bind(grade["points"].as_f64()).bind(grade["feedback"].as_str().unwrap_or("")).bind(grade["source"].as_str()).bind(grade["model"].as_str()).bind(if answer["drawing"].is_null() { None } else { Some(answer["drawing"].to_string()) })
            .execute(&mut *connection).await.map_err(db_error)?;
        newSubmissions += 1;
        refresh_question_statistics(connection, answer["questionId"].as_str().unwrap()).await?;
    }
    sqlx::query("UPDATE exercises SET draftAnswers=?,draftRevision=draftRevision+1,reviewedAt=CASE WHEN ? THEN COALESCE(reviewedAt,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE reviewedAt END WHERE id=? AND draftRevision=?")
        .bind(json!(normalized).to_string()).bind(finish).bind(exerciseId).bind(expectedRevision).execute(&mut *connection).await.map_err(db_error)?;
    let reviewedAt: Option<String> =
        sqlx::query_scalar("SELECT reviewedAt FROM exercises WHERE id=?")
            .bind(exerciseId)
            .fetch_one(connection)
            .await
            .map_err(db_error)?;
    Ok(
        json!({"revision":expectedRevision+1,"reviewedAt":reviewedAt,"newSubmissions":newSubmissions,"noteId":session["noteId"]}),
    )
}

#[tauri::command]
pub async fn save_exercise_draft(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NotesState>,
    exerciseId: String,
    expectedRevision: i64,
    answers: Vec<DraftAnswer>,
    finish: bool,
) -> Result<Value, String> {
    let folder = session_folder(&window, &app, &exerciseId)?;
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folder).await?;
    let mut transaction = connection.begin().await.map_err(db_error)?;
    let result = save_draft(
        &mut transaction,
        &exerciseId,
        expectedRevision,
        &answers,
        finish,
    )
    .await?;
    transaction.commit().await.map_err(db_error)?;
    if result["newSubmissions"].as_u64().unwrap_or(0) > 0 {
        if let Some(main) = app.get_webview_window("main") {
            // Notification failure must not turn a committed save into an error.
            let _ = main.emit("study-progress-updated", json!({"noteId":result["noteId"]}));
        }
    }
    Ok(result)
}

async fn refresh_question_statistics(
    connection: &mut SqliteConnection,
    questionId: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE questions SET lastAnsweredAt=(SELECT MAX(answeredAt) FROM answerHistory WHERE questionId=questions.id),averageScore=COALESCE((SELECT AVG(points) FROM answerHistory WHERE questionId=questions.id AND points IS NOT NULL),0) WHERE id=?")
        .bind(questionId).execute(connection).await.map_err(db_error)?;
    Ok(())
}

async fn close_session(
    connection: &mut SqliteConnection,
    exerciseId: &str,
    expectedRevision: i64,
    voidUngraded: bool,
) -> Result<Value, String> {
    let session = load_session(connection, exerciseId).await?;
    if !session["closedAt"].is_null() {
        return Ok(session);
    }
    if session["revision"].as_i64() != Some(expectedRevision) {
        return Err("This session changed. Reload before closing.".into());
    }
    let drafts = session["draftAnswers"]
        .as_array()
        .ok_or("Invalid drafts.")?;
    let ungraded = drafts.iter().any(|answer| {
        answer["grade"].is_null()
            && (!answer["text"].as_str().unwrap_or("").trim().is_empty()
                || has_drawing(&answer["drawing"]))
    });
    if ungraded && !voidUngraded {
        return Err(
            "Grade your answers or confirm discarding ungraded answers before closing.".into(),
        );
    }
    let kept: Vec<Value> = drafts
        .iter()
        .filter(|answer| !answer["grade"].is_null() && answer["revealed"] == true)
        .cloned()
        .collect();
    sqlx::query("DELETE FROM submittedAnswers WHERE exerciseId=? AND points IS NULL")
        .bind(exerciseId)
        .execute(&mut *connection)
        .await
        .map_err(db_error)?;
    for question in session["questions"]
        .as_array()
        .ok_or("Invalid questions.")?
    {
        refresh_question_statistics(
            connection,
            question["id"].as_str().ok_or("Invalid question ID.")?,
        )
        .await?;
    }
    let total: f64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(points),0) AS REAL) FROM submittedAnswers WHERE exerciseId=?",
    )
    .bind(exerciseId)
    .fetch_one(&mut *connection)
    .await
    .map_err(db_error)?;
    if !kept.is_empty() {
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM performances WHERE exerciseId=? LIMIT 1")
                .bind(exerciseId)
                .fetch_optional(&mut *connection)
                .await
                .map_err(db_error)?;
        if let Some(performanceId) = existing {
            sqlx::query("UPDATE performances SET totalPoints=? WHERE id=?")
                .bind(total)
                .bind(performanceId)
                .execute(&mut *connection)
                .await
                .map_err(db_error)?;
        } else {
            sqlx::query("INSERT INTO performances (id,exerciseId,completedAt,totalPoints) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)").bind(id()).bind(exerciseId).bind(total).execute(&mut *connection).await.map_err(db_error)?;
        }
    }
    sqlx::query("UPDATE exercises SET draftAnswers=?,draftRevision=draftRevision+1,closedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now'),maxPoints=? WHERE id=?")
        .bind(json!(kept).to_string()).bind(kept.len() as f64).bind(exerciseId).execute(&mut *connection).await.map_err(db_error)?;
    load_session(connection, exerciseId).await
}

#[tauri::command]
pub async fn close_exercise_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NotesState>,
    exerciseId: String,
    expectedRevision: i64,
    voidUngraded: bool,
) -> Result<Value, String> {
    let folder = session_folder(&window, &app, &exerciseId)?;
    let _guard = state.0.lock().await;
    let (mut connection, _) = crate::database::openDatabase(&folder).await?;
    let mut transaction = connection.begin().await.map_err(db_error)?;
    let session = close_session(
        &mut transaction,
        &exerciseId,
        expectedRevision,
        voidUngraded,
    )
    .await?;
    transaction.commit().await.map_err(db_error)?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "study-progress-updated",
            json!({"noteId":session["noteId"]}),
        );
    }
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (std::path::PathBuf, SqliteConnection) {
        let folder = std::env::temp_dir().join(format!("obstudy-exercise-{}", id()));
        std::fs::create_dir(&folder).unwrap();
        let (mut connection, _) = crate::database::openDatabase(folder.to_str().unwrap())
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO notes (id,filePath,text) VALUES ('note','/vault/Intervals.md','source');
            INSERT INTO broadTopics (id,noteId,title) VALUES ('broad','note','Intervals');
            INSERT INTO subtopics (id,noteId,broadTopicId,title,text) VALUES ('sub','note','broad','Endpoints','source');
            INSERT INTO questions (id,noteId,text,exampleAnswer,difficulty,format,maxCharacters,answerCriteria,isBasicQuestion) VALUES ('q0','note','Explain endpoints','Include/exclude',0,1,100,'Explain endpoints',1);
            INSERT INTO questions (id,noteId,text,exampleAnswer,difficulty,format,choices,correctChoiceIndex,isBasicQuestion) VALUES ('q1','note','Choose the interval','A',0,0,'[\"A\",\"B\",\"C\",\"D\"]',0,0);
            INSERT INTO questionBroadTopics VALUES ('q0','broad'),('q1','broad');
            INSERT INTO questionSubtopics VALUES ('q0','sub');
            INSERT INTO questionFsrs VALUES ('q0','{\"due\":\"2026-10-25T20:00:00.000Z\",\"state\":0,\"reps\":0,\"lapses\":0,\"stability\":0,\"difficulty\":0,\"elapsed_days\":0,\"scheduled_days\":0,\"learning_steps\":0}');")
            .execute(&mut connection).await.unwrap();
        (folder, connection)
    }
    fn request(mode: &str, questionIds: &[&str]) -> ExerciseRequest {
        serde_json::from_value(json!({"noteId":"note","mode":mode,"sourceText":"source","questionIds":questionIds,"dueAfter":"2026-10-25T00:00:00.000Z","dueBefore":"2026-10-26T00:00:00.000Z","warnings":[],
            "settings":{"questionCount":10,"difficulty":0,"reuseQuestions":true,"questionFormat":2,"topicIds":[]}})).unwrap()
    }
    fn answer(
        questionId: &str,
        text: &str,
        selected: Option<usize>,
        revealed: bool,
    ) -> DraftAnswer {
        DraftAnswer {
            questionId: questionId.into(),
            text: text.into(),
            selectedChoiceIndex: selected,
            drawing: None,
            editorMode: None,
            revealed,
            grade: if revealed && selected.is_none() {
                Some(AnswerGrade {
                    points: 1.0,
                    source: "self".into(),
                    feedback: "".into(),
                    model: None,
                })
            } else {
                None
            },
        }
    }

    #[test]
    fn empty_topic_selection_survives_reopen_and_cannot_create_a_practice_session() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let note = snapshot::load_note(&mut connection, "note").await.unwrap();
            let mut request = request("practice", &["q0"]);
            assert!(!request.settings.excludeAllTopics);
            request.settings.excludeAllTopics = true;
            request.settings.topicIds.clear();
            let settingsId = insert_settings(&mut connection, &note, &request.settings)
                .await
                .unwrap();
            assert!(
                persist_exercise(&mut connection, &request)
                    .await
                    .unwrap_err()
                    .contains("Include at least one topic")
            );
            connection.close().await.unwrap();
            let (mut reopened, _) = crate::database::openDatabase(folder.to_str().unwrap())
                .await
                .unwrap();
            let restored = snapshot::settings(&mut reopened, &settingsId)
                .await
                .unwrap();
            assert_eq!(restored["excludeAllTopics"], true);
            assert_eq!(restored["topicIds"], json!([]));
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn sessions_keep_immutable_question_and_settings_snapshots_and_survive_reopen() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let mut transaction = connection.begin().await.unwrap();
            let session = persist_exercise(&mut transaction, &request("practice", &["q1", "q0"]))
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            assert_eq!(session["questions"][0]["id"], "q1");
            assert_eq!(session["noteTitle"], "Intervals");
            assert_eq!(session["maxPoints"], 2.0);
            sqlx::query("UPDATE questions SET text='Changed text',isArchived=1")
                .execute(&mut connection)
                .await
                .unwrap();
            let note = snapshot::load_note(&mut connection, "note").await.unwrap();
            let settings: PracticeSettings = serde_json::from_value(json!({"questionCount":1,"difficulty":2,"reuseQuestions":false,"questionFormat":1,"topicIds":["sub"]})).unwrap();
            insert_settings(&mut connection, &note, &settings)
                .await
                .unwrap();
            connection.close().await.unwrap();
            let (mut reopened, _) = crate::database::openDatabase(folder.to_str().unwrap())
                .await
                .unwrap();
            let restored = load_session(&mut reopened, session["id"].as_str().unwrap())
                .await
                .unwrap();
            assert_eq!(restored["questions"], session["questions"]);
            assert_eq!(restored["settings"], session["settings"]);
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn study_filters_parent_topics_and_children_before_limiting_due_cards() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            sqlx::raw_sql("INSERT INTO broadTopics (id,noteId,title) VALUES ('other','note','Sets');
                INSERT INTO subtopics (id,noteId,broadTopicId,title,text) VALUES ('child','note','other','Elements','source');
                INSERT INTO questions (id,noteId,text,exampleAnswer,difficulty,format,maxCharacters,answerCriteria,isBasicQuestion) VALUES ('q2','note','Other topic','Example',2,1,100,'Criteria',1),('q3','note','Other later','Example',1,1,100,'Criteria',1);
                INSERT INTO questionSubtopics VALUES ('q2','child');
                INSERT INTO questionBroadTopics VALUES ('q3','other');
                INSERT INTO questionFsrs SELECT 'q2',json_set(fsrsData,'$.due','2026-10-24T20:00:00Z') FROM questionFsrs WHERE questionId='q0';
                INSERT INTO questionFsrs SELECT 'q3',json_set(fsrsData,'$.due','2026-10-25T21:00:00Z') FROM questionFsrs WHERE questionId='q0';")
                .execute(&mut connection).await.unwrap();
            let mut selected = request("study", &["q0"]);
            selected.settings.questionCount = 1;
            selected.settings.topicIds = vec!["broad".into()];
            let session = persist_exercise(&mut connection, &selected).await.unwrap();
            assert_eq!(session["questions"][0]["id"], "q0");
            assert_eq!(session["settings"]["topicIds"], json!(["broad"]));
            selected.settings.topicIds = vec!["other".into()];
            assert!(persist_exercise(&mut connection, &selected).await.is_err());
            selected.questionIds = vec!["q2".into(), "q3".into()];
            selected.settings.questionCount = 2;
            let session = persist_exercise(&mut connection, &selected).await.unwrap();
            assert_eq!(session["questions"][0]["id"], "q2");
            assert_eq!(session["questions"][1]["id"], "q3");
            selected.settings.excludeAllTopics = true;
            assert!(
                persist_exercise(&mut connection, &selected)
                    .await
                    .unwrap_err()
                    .contains("Include at least one topic")
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn study_requires_due_basic_questions_and_cannot_use_additional_or_future_cards() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            assert!(
                persist_exercise(&mut connection, &request("study", &["q1"]))
                    .await
                    .is_err()
            );
            let session = persist_exercise(&mut connection, &request("study", &["q0"]))
                .await
                .unwrap();
            assert_eq!(session["questions"].as_array().unwrap().len(), 1);
            sqlx::query("UPDATE questionFsrs SET fsrsData=json_set(fsrsData,'$.due','2026-10-27T00:00:00Z')").execute(&mut connection).await.unwrap();
            assert!(
                persist_exercise(&mut connection, &request("study", &["q0"]))
                    .await
                    .is_err()
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn draft_revisions_and_answer_text_are_enforced_while_grades_do_not_reschedule_cards() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let session = persist_exercise(&mut connection, &request("practice", &["q0", "q1"]))
                .await
                .unwrap();
            let exerciseId = session["id"].as_str().unwrap();
            let beforeCard: String =
                sqlx::query_scalar("SELECT fsrsData FROM questionFsrs WHERE questionId='q0'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            let draft = [answer("q0", "My draft", None, false)];
            let first = save_draft(&mut connection, exerciseId, 0, &draft, false)
                .await
                .unwrap();
            assert_eq!(first["revision"], 1);
            let history = snapshot::load_note(&mut connection, "note").await.unwrap();
            assert_eq!(history["answers"].as_array().unwrap().len(), 0);
            assert!(
                save_draft(&mut connection, exerciseId, 0, &draft, false)
                    .await
                    .is_err()
            );
            let revealed = [answer("q0", "My submitted answer", None, true)];
            save_draft(&mut connection, exerciseId, 1, &revealed, false)
                .await
                .unwrap();
            assert!(
                save_draft(
                    &mut connection,
                    exerciseId,
                    2,
                    &[answer("q0", "Changed after reveal", None, true)],
                    false
                )
                .await
                .is_err()
            );
            assert!(
                save_draft(&mut connection, exerciseId, 2, &[], false)
                    .await
                    .is_err()
            );
            assert!(
                save_draft(&mut connection, exerciseId, 2, &revealed, true)
                    .await
                    .is_err()
            );
            assert!(
                save_draft(
                    &mut connection,
                    exerciseId,
                    2,
                    &[answer("q1", "Wrong index", Some(99), true)],
                    false
                )
                .await
                .is_err()
            );
            let complete = [
                answer("q0", "My submitted answer", None, true),
                answer("q1", "Canonicalized from choice", Some(0), true),
            ];
            let result = save_draft(&mut connection, exerciseId, 2, &complete, true)
                .await
                .unwrap();
            assert!(!result["reviewedAt"].is_null());
            let restored = load_session(&mut connection, exerciseId).await.unwrap();
            assert_eq!(restored["draftAnswers"][1]["text"], "A");
            let afterCard: String =
                sqlx::query_scalar("SELECT fsrsData FROM questionFsrs WHERE questionId='q0'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(afterCard, beforeCard);
            let performances: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM performances")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(performances, 0);
            let history = snapshot::load_note(&mut connection, "note").await.unwrap();
            assert_eq!(history["answers"].as_array().unwrap().len(), 2);
            assert!(
                history["answers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|answer| !answer["points"].is_null())
            );
            assert!(
                history["questions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|question| !question["lastAnsweredAt"].is_null())
            );
            let repeated = save_draft(&mut connection, exerciseId, 3, &complete, true)
                .await
                .unwrap();
            assert_eq!(repeated["newSubmissions"], 0);
            connection.close().await.unwrap();
            let (mut reopened, _) = crate::database::openDatabase(folder.to_str().unwrap())
                .await
                .unwrap();
            let persisted = load_session(&mut reopened, exerciseId).await.unwrap();
            assert_eq!(persisted["draftAnswers"], restored["draftAnswers"]);
            let history = snapshot::load_note(&mut reopened, "note").await.unwrap();
            assert_eq!(history["answers"].as_array().unwrap().len(), 2);
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn study_submissions_are_excluded_today_but_practice_does_not_change_study_eligibility() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let practice = persist_exercise(&mut connection, &request("practice", &["q0"]))
                .await
                .unwrap();
            save_draft(
                &mut connection,
                practice["id"].as_str().unwrap(),
                0,
                &[answer("q0", "Practice answer", None, true)],
                false,
            )
            .await
            .unwrap();
            sqlx::query("UPDATE submittedAnswers SET answeredAt='2026-10-25T12:00:00.000Z'")
                .execute(&mut connection)
                .await
                .unwrap();
            let study = persist_exercise(&mut connection, &request("study", &["q0"]))
                .await
                .unwrap();
            save_draft(
                &mut connection,
                study["id"].as_str().unwrap(),
                0,
                &[answer("q0", "Study answer", None, true)],
                false,
            )
            .await
            .unwrap();
            sqlx::query("UPDATE submittedAnswers SET answeredAt='2026-10-25T12:00:00.000Z'")
                .execute(&mut connection)
                .await
                .unwrap();
            assert!(
                persist_exercise(&mut connection, &request("study", &["q0"]))
                    .await
                    .is_err()
            );
            let mut tomorrow = request("study", &["q0"]);
            tomorrow.dueAfter = "2026-10-26T00:00:00.000Z".into();
            tomorrow.dueBefore = "2026-10-27T00:00:00.000Z".into();
            assert!(persist_exercise(&mut connection, &tomorrow).await.is_ok());
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn upgrade_recovers_revealed_answers_without_counting_unfinished_drafts_or_inventing_grades() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let session = persist_exercise(&mut connection, &request("study", &["q0"]))
                .await
                .unwrap();
            let legacy = json!([{"questionId":"q0","text":"Previously revealed","selectedChoiceIndex":null,"revealed":true}]);
            sqlx::query("UPDATE exercises SET draftAnswers=?,createdAt='2026-10-24T12:00:00.000Z'")
                .bind(legacy.to_string())
                .execute(&mut connection)
                .await
                .unwrap();
            let unfinished = persist_exercise(&mut connection, &request("practice", &["q1"]))
                .await
                .unwrap();
            sqlx::query("UPDATE exercises SET draftAnswers=? WHERE id=?").bind(json!([{"questionId":"q1","text":"Unfinished","selectedChoiceIndex":0,"revealed":false}]).to_string()).bind(unfinished["id"].as_str()).execute(&mut connection).await.unwrap();
            sqlx::raw_sql("DROP VIEW answerHistory; DROP TABLE submittedAnswers;")
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/0005_submitted_answers.sql"))
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/0008_drawing_answers.sql"))
                .execute(&mut connection)
                .await
                .unwrap();
            let history = snapshot::load_note(&mut connection, "note").await.unwrap();
            let answers = history["answers"].as_array().unwrap();
            assert_eq!(answers.len(), 1);
            assert_eq!(answers[0]["exerciseId"], session["id"]);
            assert_eq!(answers[0]["text"], "Previously revealed");
            assert!(answers[0]["points"].is_null());
            assert_eq!(
                history["questions"][0]["lastAnsweredAt"],
                "2026-10-24T12:00:00.000Z"
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn multiple_difficulties_are_saved_and_session_questions_must_match_any_selected_level() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            sqlx::query("UPDATE questions SET difficulty=2 WHERE id='q1'")
                .execute(&mut connection)
                .await
                .unwrap();
            let mut request = request("practice", &["q0", "q1"]);
            request.settings.difficulties = Some(vec![0, 2]);
            let session = persist_exercise(&mut connection, &request).await.unwrap();
            assert_eq!(session["settings"]["difficulties"], json!([0, 2]));
            assert_eq!(
                load_session(&mut connection, session["id"].as_str().unwrap())
                    .await
                    .unwrap()["settings"]["difficulties"],
                json!([0, 2])
            );
            request.settings.difficulties = Some(vec![1, 2]);
            assert!(persist_exercise(&mut connection, &request).await.is_err());
            let note = snapshot::load_note(&mut connection, "note").await.unwrap();
            request.settings.difficulties = Some(vec![]);
            assert!(
                insert_settings(&mut connection, &note, &request.settings)
                    .await
                    .is_err()
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn drawing_only_answers_survive_reopen_grading_and_close_without_allowing_edits_after_submission()
     {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let session = persist_exercise(&mut connection, &request("practice", &["q0"]))
                .await
                .unwrap();
            let exerciseId = session["id"].as_str().unwrap();
            let drawing = json!({"version":1,"width":1200,"height":800,"elements":[{"id":"stroke","type":"freedraw","x":20,"y":20,"width":10,"height":10,"angle":0,"points":[[0,0],[10,10]],"isDeleted":false,"link":null}]});
            let mut response = answer("q0", "", None, false);
            response.drawing = Some(drawing.clone());
            response.editorMode = Some("draw".into());
            save_draft(&mut connection, exerciseId, 0, &[response], false)
                .await
                .unwrap();
            assert!(
                close_session(&mut connection, exerciseId, 1, false)
                    .await
                    .is_err()
            );
            connection.close().await.unwrap();
            let (mut reopened, _) = crate::database::openDatabase(folder.to_str().unwrap())
                .await
                .unwrap();
            let restored = load_session(&mut reopened, exerciseId).await.unwrap();
            assert_eq!(restored["draftAnswers"][0]["drawing"], drawing);
            assert_eq!(restored["draftAnswers"][0]["editorMode"], "draw");
            let mut submitted = answer("q0", "", None, true);
            submitted.drawing = Some(drawing.clone());
            submitted.grade = None;
            save_draft(&mut reopened, exerciseId, 1, &[submitted], true)
                .await
                .unwrap();
            let mut changed = answer("q0", "", None, true);
            changed.drawing = Some(json!({"version":1,"width":1200,"height":800,"elements":[]}));
            assert!(
                save_draft(&mut reopened, exerciseId, 2, &[changed], false)
                    .await
                    .is_err()
            );
            let mut graded = answer("q0", "", None, true);
            graded.drawing = Some(drawing.clone());
            graded.grade.as_mut().unwrap().points = 0.5;
            save_draft(&mut reopened, exerciseId, 2, &[graded], false)
                .await
                .unwrap();
            let note = snapshot::load_note(&mut reopened, "note").await.unwrap();
            assert_eq!(note["answers"][0]["drawing"], drawing);
            assert_eq!(note["answers"][0]["points"], 0.5);
            let closed = close_session(&mut reopened, exerciseId, 3, false)
                .await
                .unwrap();
            assert_eq!(closed["draftAnswers"][0]["drawing"], drawing);
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn ungraded_drawing_discard_and_drawing_validation_preserve_answer_rules() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let session = persist_exercise(&mut connection, &request("practice", &["q0", "q1"]))
                .await
                .unwrap();
            let exerciseId = session["id"].as_str().unwrap();
            let mut response = answer("q0", "", None, true);
            response.grade = None;
            response.drawing = Some(json!({"version":1,"width":1200,"height":800,"elements":[]}));
            assert!(
                save_draft(&mut connection, exerciseId, 0, &[response], false)
                    .await
                    .is_err()
            );
            let mut invalid = answer("q0", "", None, false);
            invalid.drawing =
                Some(json!({"version":1,"width":1200,"height":800,"elements":[{"type":"image"}]}));
            assert!(
                save_draft(&mut connection, exerciseId, 0, &[invalid], false)
                    .await
                    .is_err()
            );
            let mut draft = answer("q0", "", None, false);
            draft.drawing = Some(
                json!({"version":1,"width":1200,"height":800,"elements":[{"type":"rectangle","x":10,"y":10,"width":50,"height":50,"angle":0,"isDeleted":false}]}),
            );
            save_draft(&mut connection, exerciseId, 0, &[draft], false)
                .await
                .unwrap();
            assert!(
                close_session(&mut connection, exerciseId, 1, false)
                    .await
                    .is_err()
            );
            let closed = close_session(&mut connection, exerciseId, 1, true)
                .await
                .unwrap();
            assert_eq!(closed["draftAnswers"], json!([]));
            let note = snapshot::load_note(&mut connection, "note").await.unwrap();
            assert_eq!(note["answers"], json!([]));
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn closing_without_graded_answers_handles_empty_sessions_and_discarded_work() {
        tauri::async_runtime::block_on(async {
            for scenario in ["empty", "draft", "ungraded"] {
                let (folder, mut connection) = fixture().await;
                let session =
                    persist_exercise(&mut connection, &request("practice", &["q0", "q1"]))
                        .await
                        .unwrap();
                let exerciseId = session["id"].as_str().unwrap();
                let mut revision = 0;
                if scenario != "empty" {
                    let mut response =
                        answer("q0", "Discard this text", None, scenario == "ungraded");
                    response.grade = None;
                    let saved =
                        save_draft(&mut connection, exerciseId, revision, &[response], false)
                            .await
                            .unwrap();
                    revision = saved["revision"].as_i64().unwrap();
                    assert!(
                        close_session(&mut connection, exerciseId, revision, false)
                            .await
                            .is_err()
                    );
                }
                let mut transaction = connection.begin().await.unwrap();
                let closed =
                    close_session(&mut transaction, exerciseId, revision, scenario != "empty")
                        .await
                        .unwrap();
                transaction.commit().await.unwrap();
                assert!(!closed["closedAt"].is_null(), "{scenario}");
                assert_eq!(closed["draftAnswers"], json!([]), "{scenario}");
                assert_eq!(closed["maxPoints"], 0.0, "{scenario}");
                let submitted: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM submittedAnswers WHERE exerciseId=?")
                        .bind(exerciseId)
                        .fetch_one(&mut connection)
                        .await
                        .unwrap();
                assert_eq!(submitted, 0, "{scenario}");
                connection.close().await.unwrap();
                let (mut reopened, _) = crate::database::openDatabase(folder.to_str().unwrap())
                    .await
                    .unwrap();
                let restored = load_session(&mut reopened, exerciseId).await.unwrap();
                assert_eq!(restored, closed, "{scenario}");
                let note = snapshot::load_note(&mut reopened, "note").await.unwrap();
                assert_eq!(note["answers"], json!([]), "{scenario}");
                assert_eq!(note["performances"], json!([]), "{scenario}");
                reopened.close().await.unwrap();
                std::fs::remove_dir_all(folder).unwrap();
            }
        });
    }

    #[test]
    fn closing_voids_ungraded_text_but_keeps_automatic_grades_and_creates_one_performance() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let session = persist_exercise(&mut connection, &request("practice", &["q0", "q1"]))
                .await
                .unwrap();
            let exerciseId = session["id"].as_str().unwrap();
            let mut ungraded = answer("q0", "VOID THIS TEXT", None, true);
            ungraded.grade = None;
            let mut incorrect = answer("q1", "ignored", Some(1), true);
            incorrect.grade = Some(AnswerGrade {
                points: 1.0,
                source: "self".into(),
                feedback: "fake grade".into(),
                model: None,
            });
            save_draft(
                &mut connection,
                exerciseId,
                0,
                &[ungraded, incorrect],
                false,
            )
            .await
            .unwrap();
            let history = snapshot::load_note(&mut connection, "note").await.unwrap();
            assert_eq!(history["answers"].as_array().unwrap().len(), 1);
            assert_eq!(history["answers"][0]["points"], 0.0);
            assert!(
                close_session(&mut connection, exerciseId, 1, false)
                    .await
                    .is_err()
            );
            assert!(
                close_session(&mut connection, exerciseId, 0, true)
                    .await
                    .is_err()
            );
            let closed = close_session(&mut connection, exerciseId, 1, true)
                .await
                .unwrap();
            assert!(!closed["closedAt"].is_null());
            assert_eq!(closed["draftAnswers"].as_array().unwrap().len(), 1);
            assert!(
                !closed["draftAnswers"]
                    .to_string()
                    .contains("VOID THIS TEXT")
            );
            assert_eq!(closed["maxPoints"], 1.0);
            assert!(
                save_draft(&mut connection, exerciseId, 2, &[], false)
                    .await
                    .is_err()
            );
            close_session(&mut connection, exerciseId, 2, true)
                .await
                .unwrap();
            let note = snapshot::load_note(&mut connection, "note").await.unwrap();
            assert_eq!(note["performances"].as_array().unwrap().len(), 1);
            assert_eq!(
                note["performances"][0]["answerIds"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(note["performances"][0]["totalPoints"], 0.0);
            assert!(note["questions"][0]["lastAnsweredAt"].is_null());
            connection.close().await.unwrap();
            let (mut reopened, _) = crate::database::openDatabase(folder.to_str().unwrap())
                .await
                .unwrap();
            let persisted = load_session(&mut reopened, exerciseId).await.unwrap();
            assert_eq!(persisted["draftAnswers"], closed["draftAnswers"]);
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn freeform_grading_after_results_is_validated_and_updates_statistics_without_duplicates() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let session = persist_exercise(&mut connection, &request("practice", &["q0"]))
                .await
                .unwrap();
            let exerciseId = session["id"].as_str().unwrap();
            let mut response = answer("q0", "Partial explanation", None, true);
            response.grade = None;
            save_draft(&mut connection, exerciseId, 0, &[response], true)
                .await
                .unwrap();
            let mut graded = answer("q0", "Partial explanation", None, true);
            graded.grade.as_mut().unwrap().points = 2.0;
            assert!(
                save_draft(&mut connection, exerciseId, 1, &[graded], false)
                    .await
                    .is_err()
            );
            let mut graded = answer("q0", "Partial explanation", None, true);
            graded.grade = Some(AnswerGrade {
                points: 0.5,
                source: "ai".into(),
                feedback: "Missing endpoint reasoning".into(),
                model: Some("test-model".into()),
            });
            save_draft(&mut connection, exerciseId, 1, &[graded], false)
                .await
                .unwrap();
            let note = snapshot::load_note(&mut connection, "note").await.unwrap();
            assert_eq!(note["answers"].as_array().unwrap().len(), 1);
            assert_eq!(note["answers"][0]["points"], 0.5);
            assert_eq!(note["questions"][0]["averageScore"], 0.5);
            let saved = load_session(&mut connection, exerciseId).await.unwrap();
            assert_eq!(saved["draftAnswers"][0]["grade"]["source"], "ai");
            close_session(&mut connection, exerciseId, 2, false)
                .await
                .unwrap();
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn failed_finalization_rolls_back_discard_and_keeps_recoverable_answers() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            let session = persist_exercise(&mut connection, &request("practice", &["q0", "q1"]))
                .await
                .unwrap();
            let exerciseId = session["id"].as_str().unwrap();
            let mut ungraded = answer("q0", "Recover this draft", None, true);
            ungraded.grade = None;
            save_draft(
                &mut connection,
                exerciseId,
                0,
                &[ungraded, answer("q1", "", Some(0), true)],
                false,
            )
            .await
            .unwrap();
            sqlx::raw_sql("CREATE TRIGGER rejectPerformance BEFORE INSERT ON performances BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;").execute(&mut connection).await.unwrap();
            let mut transaction = connection.begin().await.unwrap();
            assert!(
                close_session(&mut transaction, exerciseId, 1, true)
                    .await
                    .is_err()
            );
            transaction.rollback().await.unwrap();
            let restored = load_session(&mut connection, exerciseId).await.unwrap();
            assert!(restored["closedAt"].is_null());
            assert_eq!(restored["revision"], 1);
            assert!(
                restored["draftAnswers"]
                    .to_string()
                    .contains("Recover this draft")
            );
            sqlx::query("DROP TRIGGER rejectPerformance")
                .execute(&mut connection)
                .await
                .unwrap();
            assert!(
                close_session(&mut connection, exerciseId, 1, true)
                    .await
                    .is_ok()
            );
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }

    #[test]
    fn invalid_or_stale_selection_rolls_back_without_an_empty_exercise_or_settings_profile() {
        tauri::async_runtime::block_on(async {
            let (folder, mut connection) = fixture().await;
            for invalid in [
                request("practice", &["foreign"]),
                request("practice", &["q0", "q0"]),
                request("practice", &[]),
            ] {
                let mut transaction = connection.begin().await.unwrap();
                assert!(persist_exercise(&mut transaction, &invalid).await.is_err());
                transaction.rollback().await.unwrap();
            }
            let mut stale = request("practice", &["q0"]);
            stale.sourceText = "Old source".into();
            assert!(persist_exercise(&mut connection, &stale).await.is_err());
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM exercises")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            let profiles: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM practiceSettings")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(count, 0);
            assert_eq!(profiles, 0);
            connection.close().await.unwrap();
            std::fs::remove_dir_all(folder).unwrap();
        });
    }
}
