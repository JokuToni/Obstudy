use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FsrsUpdate {
    questionId: String,
    beforeCard: Value,
    afterCard: Value,
    reviewLog: Value,
    reviewedAt: String,
    rating: u8,
}

pub(super) async fn prepare(
    connection: &mut SqliteConnection,
    exerciseId: &str,
    answers: &[DraftAnswer],
) -> Result<Vec<Value>, String> {
    let session = load_session(connection, exerciseId).await?;
    if session["mode"] != "study" || !session["closedAt"].is_null() {
        return Ok(vec![]);
    }
    let now: String = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        .fetch_one(&mut *connection)
        .await
        .map_err(db_error)?;
    let mut contexts = Vec::new();
    for answer in answers.iter().filter(|answer| answer.revealed) {
        let question = session["questions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|question| question["id"].as_str() == Some(&answer.questionId))
            .ok_or("An answer does not belong to this session.")?;
        let points = if question["format"] == 0 {
            Some(
                if answer.selectedChoiceIndex.map(|index| index as u64)
                    == question["correctChoiceIndex"].as_u64()
                {
                    1.0
                } else {
                    0.0
                },
            )
        } else {
            answer.grade.as_ref().map(|grade| grade.points)
        };
        let Some(points) = points else {
            continue;
        };
        let rating = if points == 0.0 {
            1
        } else if points == 0.5 {
            2
        } else {
            3
        };
        if !(1..=4).contains(&rating) {
            return Err("Choose a valid recall rating.".into());
        }
        let previous = sqlx::query(
            "SELECT points,rating FROM fsrsReviews WHERE exerciseId=? AND questionId=?",
        )
        .bind(exerciseId)
        .bind(&answer.questionId)
        .fetch_optional(&mut *connection)
        .await
        .map_err(db_error)?;
        if let Some(previous) = previous {
            if previous.get::<f64, _>("points") != points {
                return Err(
                    "This Study answer has already updated its schedule. Its grade is final."
                        .into(),
                );
            }
            continue;
        }
        let wasGraded = session["draftAnswers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|saved| saved["questionId"] == answer.questionId && !saved["grade"].is_null());
        let pending: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM submittedAnswers WHERE exerciseId=? AND questionId=? AND fsrsPending=1)").bind(exerciseId).bind(&answer.questionId).fetch_one(&mut *connection).await.map_err(db_error)?;
        if wasGraded && !pending {
            continue;
        }
        let card: Option<String> = sqlx::query_scalar("SELECT f.fsrsData FROM questionFsrs f JOIN questions q ON q.id=f.questionId WHERE q.id=? AND q.isBasicQuestion=1 AND q.isArchived=0").bind(&answer.questionId).fetch_optional(&mut *connection).await.map_err(db_error)?;
        if let Some(card) = card {
            contexts.push(json!({"questionId":answer.questionId,"beforeCard":serde_json::from_str::<Value>(&card).map_err(|_| "Invalid saved FSRS card.")?,"reviewedAt":now,"rating":rating,"points":points}));
        }
    }
    Ok(contexts)
}

fn same_value(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same_value(value, other)))
        }
        _ => left == right,
    }
}

pub(super) async fn apply(
    connection: &mut SqliteConnection,
    exerciseId: &str,
    contexts: &[Value],
    updates: &[FsrsUpdate],
) -> Result<(), String> {
    if contexts.len() != updates.len() {
        return Err("The Study schedule update is incomplete. Try saving again.".into());
    }
    let mut ids = HashSet::new();
    for update in updates {
        if !ids.insert(&update.questionId) {
            return Err("Duplicate Study review.".into());
        }
        let context = contexts
            .iter()
            .find(|context| context["questionId"].as_str() == Some(&update.questionId))
            .ok_or("Unexpected Study review.")?;
        if !same_value(&context["beforeCard"], &update.beforeCard) {
            return Err("Study card changed. Retry scheduling with the latest card.".into());
        }
        let timely: bool = sqlx::query_scalar("SELECT COALESCE(abs(julianday(?) - julianday('now')) * 86400 <= 300 AND julianday(?) >= COALESCE(julianday(?),0) AND julianday(?) >= julianday(?),0)")
            .bind(&update.reviewedAt).bind(&update.reviewedAt).bind(update.beforeCard["last_review"].as_str()).bind(update.afterCard["due"].as_str()).bind(&update.reviewedAt)
            .fetch_one(&mut *connection).await.map_err(db_error)?;
        let card = &update.afterCard;
        if !timely
            || context["rating"].as_u64() != Some(u64::from(update.rating))
            || card["reps"].as_u64() != update.beforeCard["reps"].as_u64().map(|reps| reps + 1)
            || card["last_review"].as_str() != Some(&update.reviewedAt)
            || !card["stability"]
                .as_f64()
                .is_some_and(|value| value.is_finite() && value > 0.0)
            || !card["difficulty"]
                .as_f64()
                .is_some_and(|value| (1.0..=10.0).contains(&value))
            || !card["state"]
                .as_u64()
                .is_some_and(|value| (1..=3).contains(&value))
            || !card["scheduled_days"]
                .as_u64()
                .is_some_and(|value| value <= 36500)
            || update.reviewLog["rating"].as_u64() != Some(u64::from(update.rating))
            || update.reviewLog["review"].as_str() != Some(&update.reviewedAt)
        {
            return Err("Invalid FSRS review update.".into());
        }
        sqlx::query(
            "UPDATE submittedAnswers SET fsrsPending=0 WHERE exerciseId=? AND questionId=?",
        )
        .bind(exerciseId)
        .bind(&update.questionId)
        .execute(&mut *connection)
        .await
        .map_err(db_error)?;
        sqlx::query("UPDATE questionFsrs SET fsrsData=? WHERE questionId=?")
            .bind(card.to_string())
            .bind(&update.questionId)
            .execute(&mut *connection)
            .await
            .map_err(db_error)?;
        sqlx::query("INSERT INTO fsrsReviews (id,exerciseId,questionId,reviewedAt,rating,points,beforeCard,afterCard,reviewLog,schedulerVersion) VALUES (?,?,?,?,?,?,?,?,?,'ts-fsrs@5.4.2')")
            .bind(id()).bind(exerciseId).bind(&update.questionId).bind(&update.reviewedAt).bind(i64::from(update.rating)).bind(context["points"].as_f64())
            .bind(update.beforeCard.to_string()).bind(card.to_string()).bind(update.reviewLog.to_string()).execute(&mut *connection).await.map_err(db_error)?;
    }
    Ok(())
}
