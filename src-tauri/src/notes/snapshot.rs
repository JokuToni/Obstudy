#![allow(non_snake_case)]
use super::db_error;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|_| "Stored study data contains invalid JSON.".into())
}

async fn topic_ids(
    connection: &mut SqliteConnection,
    ownerId: &str,
    settings: bool,
) -> Result<Vec<String>, String> {
    let query = if settings {
        "SELECT topicId FROM settingsBroadTopics WHERE settingsId = ? UNION ALL SELECT topicId FROM settingsSubtopics WHERE settingsId = ?"
    } else {
        "SELECT topicId FROM questionBroadTopics WHERE questionId = ? UNION ALL SELECT topicId FROM questionSubtopics WHERE questionId = ?"
    };
    sqlx::query_scalar(query)
        .bind(ownerId)
        .bind(ownerId)
        .fetch_all(connection)
        .await
        .map_err(db_error)
}

pub(crate) async fn settings(
    connection: &mut SqliteConnection,
    settingsId: &str,
) -> Result<Value, String> {
    let row = sqlx::query("SELECT * FROM practiceSettings WHERE id = ?")
        .bind(settingsId)
        .fetch_one(&mut *connection)
        .await
        .map_err(db_error)?;
    Ok(
        json!({ "questionCount": row.get::<i64, _>("questionCount"), "difficulty": row.get::<i64, _>("difficulty"), "difficulties": parse_json(&row.get::<String,_>("difficulties"))?, "reuseQuestions": row.get::<bool, _>("reuseQuestions"), "questionFormat": row.get::<i64, _>("questionFormat"), "topicIds": topic_ids(connection, settingsId, true).await?, "excludeAllTopics": row.get::<bool, _>("excludeAllTopics") }),
    )
}

pub async fn load_notes(connection: &mut SqliteConnection) -> Result<Vec<Value>, String> {
    load_filtered_notes(connection, None).await
}

pub async fn load_note(connection: &mut SqliteConnection, noteId: &str) -> Result<Value, String> {
    load_filtered_notes(connection, Some(noteId))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "The selected note no longer exists.".into())
}

async fn load_filtered_notes(
    connection: &mut SqliteConnection,
    noteId: Option<&str>,
) -> Result<Vec<Value>, String> {
    let rows = sqlx::query("SELECT * FROM notes WHERE (? IS NULL OR id = ?) ORDER BY filePath")
        .bind(noteId)
        .bind(noteId)
        .fetch_all(&mut *connection)
        .await
        .map_err(db_error)?;
    let mut notes = Vec::new();
    for row in rows {
        let noteId: String = row.get("id");
        let mut topics = Vec::new();
        for topic in sqlx::query(
            "SELECT * FROM broadTopics WHERE noteId = ? AND isPresent = 1 ORDER BY rowid",
        )
        .bind(&noteId)
        .fetch_all(&mut *connection)
        .await
        .map_err(db_error)?
        {
            topics.push(json!({ "id": topic.get::<String,_>("id"), "noteId": noteId, "title": topic.get::<String,_>("title") }));
        }
        for topic in
            sqlx::query("SELECT * FROM subtopics WHERE noteId = ? AND isPresent = 1 ORDER BY rowid")
                .bind(&noteId)
                .fetch_all(&mut *connection)
                .await
                .map_err(db_error)?
        {
            topics.push(json!({ "id": topic.get::<String,_>("id"), "noteId": noteId, "title": topic.get::<String,_>("title"), "text": topic.get::<String,_>("text"), "broadTopicId": topic.get::<Option<String>,_>("broadTopicId") }));
        }
        let mut questions = Vec::new();
        for question in sqlx::query(
            "SELECT * FROM questions WHERE noteId = ? AND isArchived = 0 ORDER BY rowid",
        )
        .bind(&noteId)
        .fetch_all(&mut *connection)
        .await
        .map_err(db_error)?
        {
            let questionId: String = question.get("id");
            let format: i64 = question.get("format");
            let mut value = json!({ "id": questionId, "noteId": noteId, "text": question.get::<String,_>("text"), "exampleAnswer": question.get::<String,_>("exampleAnswer"), "lastAnsweredAt": question.get::<Option<String>,_>("lastAnsweredAt"), "averageScore": question.get::<f64,_>("averageScore"), "difficulty": question.get::<i64,_>("difficulty"), "format": format, "topicIds": topic_ids(connection, &questionId, false).await?, "materials": parse_json(&question.get::<String,_>("materials"))? });
            value["isBasicQuestion"] = json!(question.get::<bool, _>("isBasicQuestion"));
            value["generatedAt"] = json!(question.get::<Option<String>, _>("generatedAt"));
            value["generatedWithModel"] =
                json!(question.get::<Option<String>, _>("generatedWithModel"));
            value["generationScope"] = json!(question.get::<Option<String>, _>("generationScope"));
            if format == 0 {
                value["choices"] = parse_json(&question.get::<String, _>("choices"))?;
                value["correctChoiceIndex"] = json!(question.get::<i64, _>("correctChoiceIndex"));
            } else {
                value["maxCharacters"] = json!(question.get::<i64, _>("maxCharacters"));
                value["answerCriteria"] = json!(question.get::<String, _>("answerCriteria"));
            }
            questions.push(value);
        }
        let mut performances = Vec::new();
        let mut answers = Vec::new();
        for performance in sqlx::query("SELECT p.* FROM performances p JOIN exercises e ON e.id = p.exerciseId WHERE e.noteId = ? ORDER BY p.completedAt").bind(&noteId).fetch_all(&mut *connection).await.map_err(db_error)? {
            let performanceId: String = performance.get("id");
            let mut answerIds = Vec::new();
            for answer in sqlx::query("SELECT id FROM answerHistory WHERE exerciseId = ? ORDER BY answeredAt,id").bind(performance.get::<String,_>("exerciseId")).fetch_all(&mut *connection).await.map_err(db_error)? {
                let answerId: String = answer.get("id");
                answerIds.push(answerId.clone());
            }
            performances.push(json!({ "id": performanceId, "exerciseId": performance.get::<String,_>("exerciseId"), "completedAt": performance.get::<String,_>("completedAt"), "totalPoints": performance.get::<f64,_>("totalPoints"), "answerIds": answerIds }));
        }
        for answer in sqlx::query(
            "SELECT * FROM answerHistory WHERE noteId=? ORDER BY julianday(answeredAt),id",
        )
        .bind(&noteId)
        .fetch_all(&mut *connection)
        .await
        .map_err(db_error)?
        {
            answers.push(json!({"id":answer.get::<String,_>("id"),"exerciseId":answer.get::<String,_>("exerciseId"),"mode":answer.get::<String,_>("mode"),"questionId":answer.get::<String,_>("questionId"),"answeredAt":answer.get::<String,_>("answeredAt"),"text":answer.get::<String,_>("text"),"points":answer.get::<Option<f64>,_>("points"),"feedback":answer.get::<String,_>("feedback"),"drawing":answer.try_get::<Option<String>,_>("drawing").ok().flatten().map(|value| parse_json(&value)).transpose()?}));
        }
        let mut exercises = Vec::new();
        for exercise in sqlx::query("SELECT * FROM exercises WHERE noteId = ? ORDER BY rowid")
            .bind(&noteId)
            .fetch_all(&mut *connection)
            .await
            .map_err(db_error)?
        {
            let exerciseId: String = exercise.get("id");
            let snapshots: Vec<String> = sqlx::query_scalar("SELECT questionSnapshot FROM exerciseQuestions WHERE exerciseId = ? ORDER BY position").bind(&exerciseId).fetch_all(&mut *connection).await.map_err(db_error)?;
            let snapshots: Vec<Value> = snapshots
                .iter()
                .map(|text| parse_json(text))
                .collect::<Result<_, _>>()?;
            exercises.push(json!({ "id": exerciseId, "noteId": noteId, "mode": exercise.get::<String,_>("mode"), "maxPoints": exercise.get::<f64,_>("maxPoints"), "settings": settings(connection, &exercise.get::<String,_>("settingsId")).await?, "questions": snapshots }));
        }
        let fsrsRows = sqlx::query("SELECT f.* FROM questionFsrs f JOIN questions q ON q.id = f.questionId WHERE q.noteId = ? AND q.isBasicQuestion = 1 AND q.isArchived = 0").bind(&noteId).fetch_all(&mut *connection).await.map_err(db_error)?;
        let mut questionFsrs = Vec::new();
        for fsrs in fsrsRows {
            questionFsrs.push(json!({ "questionId": fsrs.get::<String,_>("questionId"), "fsrsData": parse_json(&fsrs.get::<String,_>("fsrsData"))? }));
        }
        let savedSettingsId: Option<String> =
            sqlx::query_scalar("SELECT settingsId FROM noteSettings WHERE noteId = ?")
                .bind(&noteId)
                .fetch_optional(&mut *connection)
                .await
                .map_err(db_error)?;
        let savedSettings = if let Some(settingsId) = savedSettingsId {
            settings(connection, &settingsId).await?
        } else {
            Value::Null
        };
        let fsrsReviewedAnswerIds: Vec<String> = sqlx::query_scalar("SELECT a.id FROM submittedAnswers a JOIN fsrsReviews r ON r.exerciseId=a.exerciseId AND r.questionId=a.questionId JOIN exercises e ON e.id=a.exerciseId WHERE e.noteId=?")
            .bind(&noteId).fetch_all(&mut *connection).await.map_err(db_error)?;
        let mut topicGrades = Vec::new();
        for topic in topics.iter().filter(|topic| topic.get("text").is_none()) {
            let topicId = topic["id"].as_str().ok_or("Invalid topic ID.")?;
            let points: Vec<f64> = sqlx::query_scalar("SELECT CAST(h.points AS REAL) FROM answerHistory h LEFT JOIN exerciseQuestions eq ON eq.exerciseId=h.exerciseId AND eq.questionId=h.questionId WHERE h.noteId=? AND h.points IS NOT NULL AND (EXISTS(SELECT 1 FROM json_each(eq.questionSnapshot,'$.broadTopicIds') t WHERE t.value=?) OR EXISTS(SELECT 1 FROM json_each(eq.questionSnapshot,'$.topicIds') t WHERE t.value=? OR t.value IN(SELECT id FROM subtopics WHERE broadTopicId=?)) OR (eq.questionSnapshot IS NULL AND (EXISTS(SELECT 1 FROM questionBroadTopics b WHERE b.questionId=h.questionId AND b.topicId=?) OR EXISTS(SELECT 1 FROM questionSubtopics s JOIN subtopics t ON t.id=s.topicId WHERE s.questionId=h.questionId AND t.broadTopicId=?)))) ORDER BY julianday(h.answeredAt) DESC,h.id DESC LIMIT 50")
                .bind(&noteId).bind(topicId).bind(topicId).bind(topicId).bind(topicId).bind(topicId)
                .fetch_all(&mut *connection).await.map_err(db_error)?;
            let average = if points.is_empty() {
                None
            } else {
                Some(points.iter().sum::<f64>() / points.len() as f64)
            };
            topicGrades.push(
                json!({"topicId":topicId,"answerCount":points.len(),"averagePoints":average}),
            );
        }
        let mut issues = Vec::new();
        for issue in sqlx::query("SELECT * FROM noteSyncIssues WHERE noteId = ? ORDER BY CASE kind WHEN 'orphanedSubtopic' THEN 0 WHEN 'topicRemoved' THEN 1 ELSE 2 END, rowid").bind(&noteId).fetch_all(&mut *connection).await.map_err(db_error)? {
            issues.push(json!({ "id": issue.get::<String,_>("id"), "noteId": noteId, "kind": issue.get::<String,_>("kind"), "topicId": issue.get::<String,_>("topicId"), "topicKind": issue.get::<String,_>("topicKind"), "title": issue.get::<String,_>("title") }));
        }
        notes.push(json!({ "id": noteId, "isStudying": row.get::<bool,_>("isStudying"), "file": { "path": row.get::<String,_>("filePath"), "text": row.get::<String,_>("text") }, "topics": topics, "questions": questions, "performances": performances, "savedPracticeSettings": savedSettings, "answers": answers, "exercises": exercises, "questionFsrs": questionFsrs, "topicGrades": topicGrades, "fsrsReviewedAnswerIds":fsrsReviewedAnswerIds, "isAvailable": row.get::<bool,_>("isAvailable"), "parseError": row.get::<Option<String>,_>("parseError"), "parseWarnings": parse_json(&row.get::<String,_>("parseWarnings"))?, "syncIssues": issues }));
    }
    Ok(notes)
}
