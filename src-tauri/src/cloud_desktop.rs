#![allow(non_snake_case)]
use crate::{database::openDatabase, notes::snapshot};
use serde_json::{Value, json};
use sqlx::{Connection, Row};
use std::collections::HashSet;

#[tauri::command]
pub async fn cloud_desktop_snapshot(
    folderPath: String,
    userId: String,
    serverUrl: String,
) -> Result<Value, String> {
    let (mut connection, _) = openDatabase(&folderPath).await?;
    let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT * FROM cloudState WHERE id=1")
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    let (revision, state) = if let Some(row) = row {
        if row.get::<String, _>("userId") != userId
            || row.get::<String, _>("serverUrl") != serverUrl
        {
            return Err("This notes folder is linked to a different account or server. Use its original account or another notes folder.".into());
        }
        (
            row.get::<i64, _>("revision"),
            serde_json::from_str::<Value>(&row.get::<String, _>("document"))
                .map_err(|_| "Invalid saved sync data.")?,
        )
    } else {
        (0, Value::Null)
    };
    let notes = snapshot::load_library_notes(&mut transaction).await?;
    let mut records = Vec::new();
    for row in sqlx::query("SELECT h.*,COALESCE(eq.questionSnapshot,c.questionSnapshot) AS questionSnapshot FROM answerHistory h LEFT JOIN exerciseQuestions eq ON eq.exerciseId=h.exerciseId AND eq.questionId=h.questionId LEFT JOIN cloudAnswers c ON c.id=h.id WHERE h.points IS NOT NULL AND h.id NOT IN(SELECT value FROM json_each(?,'$.knownAnswerIds')) ORDER BY julianday(h.answeredAt),h.id").bind(state.to_string()).fetch_all(&mut *transaction).await.map_err(|e|e.to_string())? {
        let Some(snapshot)=row.try_get::<Option<String>,_>("questionSnapshot").ok().flatten() else {continue};
        let question:Value=serde_json::from_str(&snapshot).map_err(|_|"Invalid saved question snapshot.")?;
        records.push(json!({"noteId":row.get::<String,_>("noteId"),"question":question,"answer":{"id":row.get::<String,_>("id"),"exerciseId":row.get::<String,_>("exerciseId"),"questionId":row.get::<String,_>("questionId"),"mode":row.get::<String,_>("mode"),"answeredAt":row.get::<String,_>("answeredAt"),"text":row.get::<String,_>("text"),"points":row.get::<f64,_>("points"),"feedback":row.get::<String,_>("feedback"),"drawing":row.try_get::<Option<String>,_>("drawing").ok().flatten().map(|value|serde_json::from_str::<Value>(&value)).transpose().map_err(|_|"Invalid drawing snapshot.")?}}));
    }
    let mut closedSessions = Vec::new();
    for row in sqlx::query("SELECT id,noteId,closedAt FROM exercises WHERE closedAt IS NOT NULL AND id NOT IN(SELECT value FROM json_each(?,'$.knownClosedIds'))")
        .bind(state.to_string())
        .fetch_all(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?
    {
        let exerciseId: String = row.get("id");
        let answerIds: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM answerHistory WHERE exerciseId=? AND points IS NOT NULL ORDER BY id",
        )
        .bind(&exerciseId)
        .fetch_all(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
        closedSessions.push(json!({"exerciseId":exerciseId,"noteId":row.get::<String,_>("noteId"),"closedAt":row.get::<String,_>("closedAt"),"answerIds":answerIds}));
    }
    transaction.commit().await.map_err(|e| e.to_string())?;
    Ok(
        json!({"revision":revision,"state":state,"notes":notes,"records":records,"closedSessions":closedSessions}),
    )
}
#[tauri::command]
pub async fn cloud_desktop_commit(
    folderPath: String,
    userId: String,
    serverUrl: String,
    expectedRevision: i64,
    state: Value,
    catalog: Option<Value>,
    records: Vec<Value>,
) -> Result<i64, String> {
    let (mut connection, _) = openDatabase(&folderPath).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let changed=if expectedRevision==0 {
        sqlx::query("INSERT OR IGNORE INTO cloudState(id,userId,serverUrl,revision,document) VALUES (1,?,?,1,?)").bind(&userId).bind(&serverUrl).bind(state.to_string()).execute(&mut *transaction).await
    }else{
        sqlx::query("UPDATE cloudState SET revision=revision+1,document=? WHERE id=1 AND userId=? AND serverUrl=? AND revision=?").bind(state.to_string()).bind(&userId).bind(&serverUrl).bind(expectedRevision).execute(&mut *transaction).await
    }.map_err(|e|e.to_string())?;
    if changed.rows_affected() != 1 {
        return Err("Sync data changed in another window. Try syncing again.".into());
    }
    let mut touched = HashSet::new();
    for record in records {
        let answer = &record["answer"];
        let string = |key: &str| {
            answer[key]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("Invalid synced answer: {key}"))
        };
        touched.insert(string("questionId")?);
        let points = answer["points"]
            .as_f64()
            .filter(|value| [0., 0.5, 1.].contains(value))
            .ok_or("Invalid synced grade.")?;
        sqlx::query("INSERT INTO cloudAnswers(id,exerciseId,noteId,mode,questionId,answeredAt,text,points,feedback,drawing,questionSnapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
            .bind(string("id")?).bind(string("exerciseId")?).bind(record["noteId"].as_str().ok_or("Invalid synced note.")?).bind(string("mode")?).bind(string("questionId")?).bind(string("answeredAt")?).bind(string("text")?).bind(points).bind(string("feedback")?).bind(if answer["drawing"].is_null(){None}else{Some(answer["drawing"].to_string())}).bind(record["question"].to_string()).execute(&mut *transaction).await.map_err(|e|e.to_string())?;
    }
    if let Some(catalog) = catalog {
        if let Some(sets) = catalog["sets"].as_array() {
            for set in sets {
                if let Some(cards) = set["cards"].as_array() {
                    for card in cards {
                        let questionId =
                            card["questionId"].as_str().ok_or("Invalid synced card.")?;
                        let data = card["fsrsData"].to_string();
                        let current: Option<String> = sqlx::query_scalar(
                            "SELECT fsrsData FROM questionFsrs WHERE questionId=?",
                        )
                        .bind(questionId)
                        .fetch_optional(&mut *transaction)
                        .await
                        .map_err(|error| error.to_string())?;
                        if current.as_deref().is_none_or(|value| value == data) {
                            continue;
                        }
                        // A practice window may have saved another grade while the network request was running.
                        let pending:i64=sqlx::query_scalar("SELECT COUNT(*) FROM answerHistory h WHERE h.questionId=? AND h.points IS NOT NULL AND h.id NOT IN(SELECT value FROM json_each(?,'$.knownAnswerIds'))").bind(questionId).bind(state.to_string()).fetch_one(&mut *transaction).await.map_err(|e|e.to_string())?;
                        let resetting = state["resetQueue"].as_array().is_some_and(|queue| {
                            queue.iter().any(|request| {
                                request["questionIds"].as_array().is_some_and(|ids| {
                                    ids.iter().any(|id| id.as_str() == Some(questionId))
                                })
                            })
                        });
                        if pending == 0 && !resetting {
                            sqlx::query("UPDATE questionFsrs SET fsrsData=? WHERE questionId=?")
                                .bind(card["fsrsData"].to_string())
                                .bind(questionId)
                                .execute(&mut *transaction)
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
    }
    for questionId in touched {
        sqlx::query("UPDATE questions SET lastAnsweredAt=(SELECT MAX(answeredAt) FROM answerHistory WHERE questionId=questions.id),averageScore=COALESCE((SELECT AVG(points) FROM answerHistory WHERE questionId=questions.id AND points IS NOT NULL),0) WHERE id=?").bind(questionId).execute(&mut *transaction).await.map_err(|e|e.to_string())?;
    }
    transaction.commit().await.map_err(|e| e.to_string())?;
    Ok(expectedRevision + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_answers_update_statistics_and_cache_is_bound_to_one_account() {
        tauri::async_runtime::block_on(async {
            let root = std::env::temp_dir().join(format!("obstudy-cloud-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let folder = root.to_str().unwrap().to_string();
            let (mut connection, _) = openDatabase(&folder).await.unwrap();
            sqlx::query("INSERT INTO notes(id,filePath,isStudying) VALUES ('note','note.md',1)")
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::query("INSERT INTO questions(id,noteId,text,exampleAnswer,difficulty,format,maxCharacters,answerCriteria,isBasicQuestion) VALUES ('question','note','Explain','Example',1,1,200,'Criteria',1)").execute(&mut connection).await.unwrap();
            let card = json!({"due":"2026-01-01T00:00:00.000Z","stability":0,"difficulty":0,"elapsed_days":0,"scheduled_days":0,"learning_steps":0,"reps":0,"lapses":0,"state":0});
            sqlx::query("INSERT INTO questionFsrs(questionId,fsrsData) VALUES ('question',?)")
                .bind(card.to_string())
                .execute(&mut connection)
                .await
                .unwrap();
            connection.close().await.unwrap();
            let before = cloud_desktop_snapshot(
                folder.clone(),
                "account".into(),
                "https://api.example.com".into(),
            )
            .await
            .unwrap();
            assert_eq!(before["revision"], 0);
            let record = json!({"noteId":"note","question":{"id":"question","topicIds":[]},"answer":{"id":"remote-answer","exerciseId":"remote-session","mode":"study","questionId":"question","answeredAt":"2026-01-02T00:00:00.000Z","text":"Answer","points":0.5,"feedback":""}});
            let state = json!({"schemaVersion":1,"knownAnswerIds":["remote-answer"]});
            let mut updated = card.clone();
            updated["reps"] = json!(1);
            let catalog =
                json!({"sets":[{"cards":[{"questionId":"question","fsrsData":updated}]}]});
            assert_eq!(
                cloud_desktop_commit(
                    folder.clone(),
                    "account".into(),
                    "https://api.example.com".into(),
                    0,
                    state.clone(),
                    Some(catalog),
                    vec![record]
                )
                .await
                .unwrap(),
                1
            );
            let loaded = cloud_desktop_snapshot(
                folder.clone(),
                "account".into(),
                "https://api.example.com".into(),
            )
            .await
            .unwrap();
            assert!(loaded["records"].as_array().unwrap().is_empty());
            let (mut check, _) = openDatabase(root.to_str().unwrap()).await.unwrap();
            let full = snapshot::load_note(&mut check, "note").await.unwrap();
            assert_eq!(full["answers"][0]["id"], "remote-answer");
            check.close().await.unwrap();
            assert_eq!(loaded["notes"][0]["questions"][0]["averageScore"], 0.5);
            assert_eq!(loaded["notes"][0]["questionFsrs"][0]["fsrsData"]["reps"], 1);
            assert!(
                cloud_desktop_snapshot(
                    folder.clone(),
                    "another-account".into(),
                    "https://api.example.com".into()
                )
                .await
                .is_err()
            );
            assert!(
                cloud_desktop_commit(
                    folder,
                    "account".into(),
                    "https://api.example.com".into(),
                    0,
                    state,
                    None,
                    vec![]
                )
                .await
                .is_err()
            );
            std::fs::remove_dir_all(root).unwrap();
        });
    }
}
