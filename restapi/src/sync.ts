import type { Database, Connection } from "./database.js";
import { fsrs, TypeConvert, type Grade } from "ts-fsrs";
import { createHash } from "node:crypto";
import type { AuthContext } from "./auth.js";
import { canonical } from "./security.js";
import { requireValue } from "./errors.js";
import { readCatalog, versionCatalog, type AccountVersion } from "./library.js";
import type { Answer, Catalog, Question, SyncEvent } from "./schemas.js";

const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });
const json = (value: unknown) => JSON.stringify(value);
const ratingFor = (points: number): Grade =>
    points === 0 ? 1 : points === 0.5 ? 2 : 3;
function notFuture(timestamp: string): void {
    requireValue(
        Date.parse(timestamp) <= Date.now() + 300_000,
        "Event time is too far in the future.",
    );
}
async function ensureExercise(
    client: Connection,
    auth: AuthContext,
    exerciseId: string,
    noteId: string,
    mode: string | null,
) {
    await client.query(
        "INSERT INTO exercises(user_id,id,device_id,note_id,mode) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(user_id,id) DO NOTHING",
        [auth.userId, exerciseId, auth.deviceId, noteId, mode],
    );
    const result = await client.query(
        "SELECT * FROM exercises WHERE user_id=$1 AND id=$2",
        [auth.userId, exerciseId],
    );
    const exercise = result.rows[0]!;
    requireValue(
        exercise.device_id === auth.deviceId &&
            exercise.note_id === noteId &&
            (!mode || exercise.mode === mode),
        "Session identity conflicts with a saved session.",
        409,
    );
    requireValue(!exercise.closed_at, "Session is already closed.", 409);
}
async function acceptAnswer(
    client: Connection,
    auth: AuthContext,
    event: Extract<SyncEvent, { kind: "answer.graded" }>,
    sequence: string,
    catalog: Catalog,
): Promise<string | null> {
    const { noteId, answer, question } = event.payload;
    const published = catalog.sets
        .find((set) => set.id === noteId)
        ?.questions.find((item) => item.id === answer.questionId);
    requireValue(
        published && canonical(published) === canonical(question),
        "Question snapshot does not match its published catalog.",
        409,
    );
    requireValue(
        answer.questionId === question.id && noteId === question.noteId,
        "Answer question does not match.",
    );
    notFuture(answer.answeredAt);
    requireValue(
        Date.parse(answer.answeredAt) <= Date.parse(event.occurredAt) + 300_000,
        "Answer time is later than its event.",
    );
    if (question.format === 0) {
        const index = question.choices.indexOf(answer.text);
        requireValue(
            index >= 0 &&
                answer.points ===
                    (index === question.correctChoiceIndex ? 1 : 0),
            "Multiple-choice grade or selection is incorrect.",
        );
        requireValue(
            !answer.drawing,
            "Multiple-choice answers cannot contain drawings.",
        );
    } else {
        requireValue(
            [...answer.text].length <= question.maxCharacters &&
                (answer.text.trim() || answer.drawing?.elements.length),
            "Free-text answer is empty or exceeds its limit.",
        );
    }
    await ensureExercise(client, auth, answer.exerciseId, noteId, answer.mode);
    await client.query(
        "INSERT INTO answers(user_id,id,exercise_id,question_id,note_id,answered_at,sequence,document,question) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
            auth.userId,
            answer.id,
            answer.exerciseId,
            answer.questionId,
            noteId,
            new Date(answer.answeredAt).toISOString(),
            sequence,
            json(answer),
            json(question),
        ],
    );
    return answer.mode === "study" && question.isBasicQuestion
        ? question.id
        : null;
}
async function verifyReview(
    client: Connection,
    auth: AuthContext,
    event: Extract<SyncEvent, { kind: "review.applied" }>,
) {
    const { answerId, exerciseId, review } = event.payload;
    const result = await client.query(
        "SELECT a.document,a.question,e.device_id FROM answers a JOIN exercises e ON a.user_id=e.user_id AND a.exercise_id=e.id WHERE a.user_id=$1 AND a.id=$2",
        [auth.userId, answerId],
    );
    const stored = result.rows[0]!;
    requireValue(
        stored,
        "Review requires its graded answer in this or an earlier batch.",
        409,
    );
    const answer = stored.document as Answer;
    requireValue(
        stored.device_id === auth.deviceId &&
            answer.exerciseId === exerciseId &&
            answer.questionId === review.questionId &&
            answer.mode === "study" &&
            stored.question.isBasicQuestion,
        "Review does not match a Study answer.",
    );
    requireValue(
        review.rating === ratingFor(answer.points) &&
            Date.parse(review.reviewedAt) === Date.parse(answer.answeredAt),
        "Review grade or time does not match the answer.",
    );
    // Client card calculations are provisional. Rebuild from trusted baseline and grades.
}
async function closeExercise(
    client: Connection,
    auth: AuthContext,
    event: Extract<SyncEvent, { kind: "session.closed" }>,
    catalog: Catalog,
) {
    const { exerciseId, noteId, answerIds } = event.payload;
    requireValue(
        catalog.sets.some((set) => set.id === noteId),
        "Session note is absent from its catalog.",
    );
    const existing = await client.query(
        "SELECT * FROM exercises WHERE user_id=$1 AND id=$2",
        [auth.userId, exerciseId],
    );
    requireValue(
        !existing.rows[0]!?.closed_at,
        "Session has already been closed.",
        409,
    );
    await ensureExercise(
        client,
        auth,
        exerciseId,
        noteId,
        existing.rows[0]!?.mode ?? null,
    );
    const result = await client.query(
        "SELECT id FROM answers WHERE user_id=$1 AND exercise_id=$2",
        [auth.userId, exerciseId],
    );
    const ids = new Set(answerIds);
    requireValue(
        ids.size === answerIds.length &&
            result.rows.length === ids.size &&
            result.rows.every((row) => ids.has(row.id)),
        "Closed session answer IDs must match all saved graded answers.",
        409,
    );
    await client.query(
        "UPDATE exercises SET closed_at=$3 WHERE user_id=$1 AND id=$2",
        [auth.userId, exerciseId, event.occurredAt],
    );
}
async function rebuildCard(
    client: Connection,
    userId: string,
    questionId: string,
): Promise<void> {
    const result = await client.query(
        "SELECT base_card FROM cards WHERE user_id=$1 AND question_id=$2",
        [userId, questionId],
    );
    requireValue(result.rowCount, "A Study question has no server card.", 409);
    let card = TypeConvert.card(result.rows[0]!.base_card);
    const answers = await client.query(
        "SELECT id,document FROM answers WHERE user_id=$1 AND question_id=$2 AND json_extract(document,'$.mode')='study' ORDER BY answered_at,id COLLATE BINARY",
        [userId, questionId],
    );
    for (const row of answers.rows) {
        const answer = row.document as Answer;
        const at = new Date(answer.answeredAt);
        requireValue(
            !card.last_review || at >= card.last_review,
            "Review predates the imported card baseline. Import earlier history separately.",
            409,
        );
        const rating = ratingFor(answer.points);
        const record = scheduler.next(card, at, rating);
        const review = {
            questionId,
            beforeCard: card,
            afterCard: record.card,
            reviewedAt: answer.answeredAt,
            rating,
            reviewLog: record.log,
        };
        await client.query(
            "INSERT INTO reviews(user_id,answer_id,document) VALUES ($1,$2,$3) ON CONFLICT(user_id,answer_id) DO UPDATE SET document=EXCLUDED.document",
            [userId, answer.id, json(review)],
        );
        card = record.card;
    }
    await client.query(
        "UPDATE cards SET current_card=$3 WHERE user_id=$1 AND question_id=$2",
        [userId, questionId, json(card)],
    );
}
export async function exchange(
    client: Connection,
    auth: AuthContext,
    user: AccountVersion,
    request: { deviceId: string; cursor: string | null; events: SyncEvent[] },
) {
    requireValue(
        request.deviceId === auth.deviceId,
        "Sync device does not match the authenticated device.",
        403,
    );
    const cursor = BigInt(request.cursor ?? "0");
    requireValue(
        cursor <= BigInt(user.revision),
        "Sync cursor is ahead of the account. Start with a null cursor.",
        409,
    );
    const ids = new Set(request.events.map((event) => event.id));
    requireValue(
        ids.size === request.events.length,
        "Duplicate event IDs in request.",
    );
    const fresh: { event: SyncEvent; digest: string; catalog: Catalog }[] = [];
    const versions = new Map<string, Catalog>();
    for (const event of request.events) {
        requireValue(
            event.deviceId === auth.deviceId,
            "Event belongs to another device.",
            403,
        );
        const digest = createHash("sha256")
            .update(canonical(event))
            .digest("hex");
        const old = await client.query(
            "SELECT digest FROM sync_events WHERE user_id=$1 AND id=$2",
            [auth.userId, event.id],
        );
        if (old.rowCount) {
            requireValue(
                old.rows[0]!.digest === digest,
                "An event ID was reused with different content.",
                409,
            );
            continue;
        }
        notFuture(event.occurredAt);
        let catalog = versions.get(event.catalogRevision);
        if (!catalog) {
            catalog = await versionCatalog(
                client,
                auth.userId,
                event.catalogRevision,
            );
            versions.set(event.catalogRevision, catalog);
        }
        fresh.push({ event, digest, catalog });
    }
    // Resolve dependencies regardless of array order; all changes roll back together.
    const phases = ["answer.graded", "review.applied", "session.closed"];
    fresh.sort(
        (a, b) => phases.indexOf(a.event.kind) - phases.indexOf(b.event.kind),
    );
    const changedCards = new Set<string>();
    for (const { event, digest, catalog } of fresh) {
        user.revision = (BigInt(user.revision) + 1n).toString();
        await client.query(
            "INSERT INTO sync_events(user_id,id,sequence,document,digest) VALUES ($1,$2,$3,$4,$5)",
            [auth.userId, event.id, user.revision, json(event), digest],
        );
        if (event.kind === "answer.graded") {
            const questionId = await acceptAnswer(
                client,
                auth,
                event,
                user.revision,
                catalog,
            );
            if (questionId) changedCards.add(questionId);
        } else if (event.kind === "review.applied")
            await verifyReview(client, auth, event);
        else await closeExercise(client, auth, event, catalog);
    }
    for (const questionId of changedCards)
        await rebuildCard(client, auth.userId, questionId);
    await client.query("UPDATE users SET revision=$2 WHERE id=$1", [
        auth.userId,
        user.revision,
    ]);
    await client.query(
        "UPDATE devices SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=$1 AND id=$2",
        [auth.userId, auth.deviceId],
    );
    const changes = await client.query(
        "SELECT sequence,document FROM sync_events WHERE user_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 501",
        [auth.userId, cursor.toString()],
    );
    const hasMore = changes.rows.length > 500;
    const page = changes.rows.slice(0, 500);
    return {
        cursor: hasMore ? (page.at(-1)!.sequence as string) : user.revision,
        acknowledgedIds: request.events.map((event) => event.id),
        catalog: await readCatalog(client, user),
        events: page.map((row) => ({
            sequence: row.sequence as string,
            event: row.document as SyncEvent,
        })),
        hasMore,
    };
}
