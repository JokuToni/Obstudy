import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyCard, fsrs, TypeConvert } from "ts-fsrs";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, migrate, transaction } from "../src/database.js";
import type { Catalog, Question, SyncEvent } from "../src/schemas.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "obstudy-api-test-"));
const config = loadConfig({
    DATABASE_PATH: join(temporaryDirectory, "test.db"),
    LOG_LEVEL: "silent",
    REGISTRATION_ENABLED: "true",
});
let database = createDatabase(config);
let app = buildApp(config, database);
const password = "a-long-test-password";
let sourceAddress = 10;

before(async () => {
    await migrate(database);
    await migrate(database);
    await app.ready();
});
after(async () => {
    await app.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
});
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
async function register(deviceId = randomUUID()) {
    const email = `${randomUUID()}@example.com`;
    const response = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        remoteAddress: `127.0.0.${sourceAddress++}`,
        payload: { email, password, deviceId, deviceName: "Test device" },
    });
    assert.equal(response.statusCode, 201, response.body);
    return { ...response.json(), email } as {
        token: string;
        userId: string;
        deviceId: string;
        email: string;
    };
}
async function login(user: { email: string }, deviceId = randomUUID()) {
    const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
            email: user.email,
            password,
            deviceId,
            deviceName: "Second device",
        },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { token: string; deviceId: string };
}
function catalog(): Catalog {
    const base = {
        noteId: "note-1",
        isBasicQuestion: true,
        generatedAt: null,
        generatedWithModel: null,
        generationScope: null,
        lastAnsweredAt: null,
        averageScore: 0,
        topicIds: ["topic-1"],
        difficulty: 0 as const,
        materials: [],
    };
    const questions: Question[] = [
        {
            ...base,
            id: "choice-1",
            format: 0,
            text: "Which one?",
            choices: ["A", "B"],
            correctChoiceIndex: 0,
            exampleAnswer: "A",
        },
        {
            ...base,
            id: "text-1",
            format: 1,
            text: "Explain.",
            maxCharacters: 200,
            answerCriteria: "Explanation",
            exampleAnswer: "Example",
        },
    ];
    return {
        schemaVersion: 1,
        revision: "local-v1",
        sets: [
            {
                id: "note-1",
                title: "Test note",
                topics: [{ id: "topic-1", noteId: "note-1", title: "Topic" }],
                questions,
                cards: questions.map((question) => ({
                    questionId: question.id,
                    fsrsData: JSON.parse(
                        JSON.stringify(
                            createEmptyCard(new Date("2026-01-01T00:00:00Z")),
                        ),
                    ),
                })),
            },
        ],
    };
}
async function publish(
    user: { token: string },
    document = catalog(),
    baseRevision: string | null = null,
) {
    const response = await app.inject({
        method: "PUT",
        url: "/v1/library",
        headers: headers(user.token),
        payload: { baseRevision, catalog: document },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().catalog as Catalog;
}
function answerEvent(
    deviceId: string,
    document: Catalog,
    options: {
        mode?: "study" | "practice";
        at?: string;
        points?: 0 | 0.5 | 1;
        questionIndex?: number;
        exerciseId?: string;
    } = {},
): SyncEvent & { kind: "answer.graded" } {
    const question = document.sets[0]!.questions[options.questionIndex ?? 0]!;
    const at = options.at ?? "2026-01-02T12:00:00.000Z";
    const points = options.points ?? 1;
    return {
        id: randomUUID(),
        deviceId,
        occurredAt: at,
        catalogRevision: document.revision,
        kind: "answer.graded",
        payload: {
            noteId: "note-1",
            question,
            answer: {
                id: randomUUID(),
                questionId: question.id,
                exerciseId: options.exerciseId ?? randomUUID(),
                mode: options.mode ?? "study",
                text:
                    question.format === 0
                        ? points === 1
                            ? "A"
                            : "B"
                        : "My explanation",
                points,
                answeredAt: at,
                feedback: "",
            },
        },
    };
}
async function sync(
    user: { token: string; deviceId: string },
    events: SyncEvent[],
    cursor: string | null = null,
) {
    return app.inject({
        method: "POST",
        url: "/v1/sync",
        headers: headers(user.token),
        payload: { schemaVersion: 1, deviceId: user.deviceId, cursor, events },
    });
}

test("health, readiness, API schema, validation, and authentication boundary", async () => {
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject("/ready")).statusCode, 200);
    assert.equal((await app.inject("/openapi.json")).json().openapi, "3.0.3");
    for (const route of [
        "/v1/library",
        "/v1/answers",
        "/v1/reviews",
        "/v1/devices",
        "/v1/me",
    ])
        assert.equal((await app.inject(route)).statusCode, 401);
    const invalid = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: { email: "bad", password: "short" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.throws(() =>
        loadConfig({ DATABASE_PATH: config.databasePath, PORT: "0" }),
    );
    assert.throws(() =>
        loadConfig({ DATABASE_PATH: config.databasePath, CORS_ORIGINS: "*" }),
    );
});

test("accounts, persistent hashed sessions, device revocation, and password changes", async () => {
    const user = await register();
    const device = await login(user);
    const stored = await database.query(
        "SELECT password_hash FROM users WHERE id=$1",
        [user.userId],
    );
    assert.notEqual(stored.rows[0]!.password_hash, password);
    const tokens = await database.query(
        "SELECT token_hash FROM auth_sessions WHERE user_id=$1",
        [user.userId],
    );
    assert(tokens.rows.every((row) => row.token_hash !== user.token));
    assert.equal(
        (
            await app.inject({ url: "/v1/me", headers: headers(device.token) })
        ).json().user.email,
        user.email,
    );
    assert.equal(
        (
            await app.inject({
                method: "DELETE",
                url: `/v1/devices/${device.deviceId}`,
                headers: headers(user.token),
            })
        ).statusCode,
        204,
    );
    assert.equal(
        (await app.inject({ url: "/v1/me", headers: headers(device.token) }))
            .statusCode,
        401,
    );
    const change = await app.inject({
        method: "POST",
        url: "/v1/auth/password",
        headers: headers(user.token),
        payload: {
            currentPassword: password,
            newPassword: "a-new-test-password",
        },
    });
    assert.equal(change.statusCode, 204, change.body);
    assert.equal(
        (await app.inject({ url: "/v1/me", headers: headers(user.token) }))
            .statusCode,
        401,
    );
    const old = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
            email: user.email,
            password,
            deviceId: user.deviceId,
            deviceName: "test",
        },
    });
    assert.equal(old.statusCode, 401);
    const updated = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
            email: user.email,
            password: "a-new-test-password",
            deviceId: user.deviceId,
            deviceName: "test",
        },
    });
    assert.equal(updated.statusCode, 200);
});

test("library revisions reject lost updates, preserve schedules, and isolate accounts", async () => {
    const user = await register();
    const other = await register();
    const first = await publish(user);
    const stale = await app.inject({
        method: "PUT",
        url: "/v1/library",
        headers: headers(user.token),
        payload: { baseRevision: null, catalog: catalog() },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(
        (
            await app.inject({
                url: "/v1/library",
                headers: headers(other.token),
            })
        ).statusCode,
        404,
    );
    const invalid = catalog();
    invalid.sets[0]!.questions[0]!.topicIds = ["missing"];
    assert.equal(
        (
            await app.inject({
                method: "PUT",
                url: "/v1/library",
                headers: headers(user.token),
                payload: { baseRevision: first.revision, catalog: invalid },
            })
        ).statusCode,
        400,
    );
    const [a, b] = await Promise.all(
        [1, 2].map(() =>
            app.inject({
                method: "PUT",
                url: "/v1/library",
                headers: headers(user.token),
                payload: { baseRevision: first.revision, catalog: catalog() },
            }),
        ),
    );
    assert(a && b);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    const current = (
        await app.inject({ url: "/v1/library", headers: headers(user.token) })
    ).json().catalog;
    const changed = catalog();
    changed.sets[0]!.questions[0]!.text = "Different question";
    assert.equal(
        (
            await app.inject({
                method: "PUT",
                url: "/v1/library",
                headers: headers(user.token),
                payload: { baseRevision: current.revision, catalog: changed },
            })
        ).statusCode,
        409,
    );
});

test("batched retries, concurrent duplicate uploads, correctness, and atomic rollback", async () => {
    const user = await register();
    const document = await publish(user);
    const event = answerEvent(user.deviceId, document);
    const [first, second] = await Promise.all([
        sync(user, [event]),
        sync(user, [event]),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json().acknowledgedIds, [event.id]);
    const answers = await app.inject({
        url: "/v1/answers",
        headers: headers(user.token),
    });
    assert.equal(answers.json().answers.length, 1);
    const reused = structuredClone(event);
    reused.payload.answer.feedback = "Changed";
    assert.equal((await sync(user, [reused])).statusCode, 409);
    const good = answerEvent(user.deviceId, document, { questionIndex: 1 });
    const bad = answerEvent(user.deviceId, document);
    bad.payload.answer.points = 0;
    assert.equal((await sync(user, [good, bad])).statusCode, 400);
    assert.equal(
        (
            await app.inject({
                url: "/v1/answers",
                headers: headers(user.token),
            })
        ).json().answers.length,
        1,
    );
    const invalidDevice = structuredClone(good);
    invalidDevice.deviceId = "another-device";
    assert.equal((await sync(user, [invalidDevice])).statusCode, 403);
    const tampered = structuredClone(good);
    tampered.payload.question.text = "Injected";
    assert.equal((await sync(user, [tampered])).statusCode, 409);
});

test("late offline reviews replay in deterministic time order and Practice never changes FSRS", async () => {
    const user = await register();
    const second = await login(user);
    const document = await publish(user);
    const later = answerEvent(user.deviceId, document, {
        at: "2026-01-04T12:00:00.000Z",
        points: 0,
    });
    const earlier = answerEvent(second.deviceId, document, {
        at: "2026-01-02T12:00:00.000Z",
        points: 1,
    });
    assert.equal((await sync(user, [later])).statusCode, 200);
    const response = await sync(second, [earlier]);
    assert.equal(response.statusCode, 200, response.body);
    const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });
    const baseline = TypeConvert.card(document.sets[0]!.cards[0]!.fsrsData);
    const one = scheduler.next(
        baseline,
        new Date(earlier.payload.answer.answeredAt),
        3,
    ).card;
    const expected = scheduler.next(
        one,
        new Date(later.payload.answer.answeredAt),
        1,
    ).card;
    const actual = response.json().catalog.sets[0].cards[0].fsrsData;
    assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
    const practice = answerEvent(user.deviceId, document, {
        mode: "practice",
        at: "2026-01-05T12:00:00.000Z",
    });
    const after = await sync(user, [practice]);
    assert.equal(after.statusCode, 200, after.body);
    assert.deepEqual(after.json().catalog.sets[0].cards[0].fsrsData, actual);
    const reviews = await app.inject({
        url: "/v1/reviews",
        headers: headers(user.token),
    });
    assert.equal(reviews.json().reviews.length, 2);
    const next = await publish(user, catalog(), after.json().catalog.revision);
    assert.deepEqual(next.sets[0]!.cards[0]!.fsrsData, actual);
});

test("review and close dependencies, old snapshots, closed answer immutability, and pagination", async () => {
    const user = await register();
    const original = await publish(user);
    await publish(user, { ...catalog(), sets: [] }, original.revision);
    const answer = answerEvent(user.deviceId, original, {
        questionIndex: 1,
        points: 0.5,
    });
    const baseline = original.sets[0]!.cards[1]!.fsrsData;
    const review: SyncEvent = {
        id: randomUUID(),
        deviceId: user.deviceId,
        occurredAt: answer.occurredAt,
        catalogRevision: original.revision,
        kind: "review.applied",
        payload: {
            answerId: answer.payload.answer.id,
            exerciseId: answer.payload.answer.exerciseId,
            review: {
                questionId: answer.payload.question.id,
                beforeCard: baseline,
                afterCard: baseline,
                reviewedAt: answer.payload.answer.answeredAt,
                rating: 2,
                reviewLog: {},
            },
        },
    };
    const close: SyncEvent = {
        id: randomUUID(),
        deviceId: user.deviceId,
        occurredAt: answer.occurredAt,
        catalogRevision: original.revision,
        kind: "session.closed",
        payload: {
            exerciseId: answer.payload.answer.exerciseId,
            noteId: "note-1",
            answerIds: [answer.payload.answer.id],
        },
    };
    const response = await sync(user, [close, review, answer]);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await sync(user, [answer, review, close])).statusCode, 200);
    const duplicateAnswer = structuredClone(answer);
    duplicateAnswer.id = randomUUID();
    duplicateAnswer.payload.answer.id = randomUUID();
    assert.equal((await sync(user, [duplicateAnswer])).statusCode, 409);
    const page = await app.inject({
        url: "/v1/answers?limit=1",
        headers: headers(user.token),
    });
    assert.equal(page.json().answers.length, 1);
    const empty = await app.inject({
        url: `/v1/answers?after=${page.json().cursor}`,
        headers: headers(user.token),
    });
    assert.equal(empty.json().answers.length, 0);
    assert.equal(
        (
            await app.inject({
                url: "/v1/answers?after=9999999999999999999",
                headers: headers(user.token),
            })
        ).statusCode,
        400,
    );
    assert.equal((await sync(user, [], "999999")).statusCode, 409);
});

test("durable data and sessions survive service restart; account deletion removes all data", async () => {
    const user = await register();
    const document = await publish(user);
    const event = answerEvent(user.deviceId, document);
    assert.equal((await sync(user, [event])).statusCode, 200);
    await app.close();
    database = createDatabase(config);
    app = buildApp(config, database);
    await app.ready();
    assert.equal(
        (await app.inject({ url: "/v1/me", headers: headers(user.token) }))
            .statusCode,
        200,
    );
    assert.equal(
        (
            await app.inject({
                url: "/v1/answers",
                headers: headers(user.token),
            })
        ).json().answers.length,
        1,
    );
    const deleted = await app.inject({
        method: "DELETE",
        url: "/v1/me",
        headers: headers(user.token),
        payload: { password },
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
    for (const table of [
        "users",
        "devices",
        "auth_sessions",
        "answers",
        "reviews",
        "cards",
        "sync_events",
        "library_versions",
        "exercises",
    ]) {
        const column = table === "users" ? "id" : "user_id";
        assert.equal(
            (
                await database.query(
                    `SELECT count(*) AS count FROM ${table} WHERE ${column}=$1`,
                    [user.userId],
                )
            ).rows[0]!.count,
            "0",
        );
    }
    assert.equal(
        (await app.inject({ url: "/v1/me", headers: headers(user.token) }))
            .statusCode,
        401,
    );
});

test("cross-account catalog access, expired sessions, logout, CORS, and auth throttling", async () => {
    const user = await register();
    const other = await register();
    const library = await publish(user);
    const stolen = answerEvent(other.deviceId, library);
    assert.equal((await sync(other, [stolen])).statusCode, 409);
    assert.equal(
        (
            await app.inject({
                url: `/v1/devices/${user.deviceId}`,
                method: "DELETE",
                headers: headers(other.token),
            })
        ).statusCode,
        404,
    );
    const logout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: headers(other.token),
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(
        (await app.inject({ url: "/v1/me", headers: headers(other.token) }))
            .statusCode,
        401,
    );
    await database.query(
        "UPDATE auth_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=$1",
        [user.userId],
    );
    assert.equal(
        (await app.inject({ url: "/v1/me", headers: headers(user.token) }))
            .statusCode,
        401,
    );
    for (let attempt = 0; attempt < 11; attempt++) {
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/login",
            remoteAddress: "192.0.2.44",
            payload: {
                email: "absent@example.com",
                password,
                deviceId: "test",
                deviceName: "test",
            },
        });
        assert.equal(
            response.statusCode,
            attempt === 10 ? 429 : 401,
            response.body,
        );
    }
    const denied = await app.inject({
        url: "/v1/me",
        headers: { origin: "https://untrusted.example" },
    });
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
    const closedRegistration = buildApp({
        ...config,
        registrationEnabled: false,
    });
    try {
        const response = await closedRegistration.inject({
            method: "POST",
            url: "/v1/auth/register",
            payload: {},
        });
        assert.equal(response.statusCode, 403);
    } finally {
        await closedRegistration.close();
    }
});

test("event feed pagination does not lose events or advance past undelivered changes", async () => {
    const user = await register();
    const document = await publish(user);
    const batch = Array.from({ length: 500 }, () =>
        answerEvent(user.deviceId, document, { mode: "practice" }),
    );
    const first = await sync(user, batch);
    assert.equal(first.statusCode, 200, first.body);
    const last = answerEvent(user.deviceId, document, { mode: "practice" });
    const second = await sync(user, [last]);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().hasMore, true);
    assert.equal(second.json().events.length, 500);
    const next = await sync(user, [], second.json().cursor);
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().hasMore, false);
    assert.equal(next.json().events.length, 1);
    assert.equal(next.json().events[0].event.id, last.id);
    assert.equal(
        new Set(
            [...second.json().events, ...next.json().events].map(
                (item) => item.event.id,
            ),
        ).size,
        501,
    );
    const tooLarge = await sync(user, [...batch, last]);
    assert.equal(tooLarge.statusCode, 400);
});

test("migration checksums detect modified applied history without modifying SQL files", async () => {
    const original = (
        await database.query(
            "SELECT digest FROM schema_migrations WHERE name='0001_sqlite_sync.sql'",
        )
    ).rows[0]!.digest;
    await database.query(
        "UPDATE schema_migrations SET digest='mismatched' WHERE name='0001_sqlite_sync.sql'",
    );
    try {
        await assert.rejects(migrate(database), /Applied migration changed/);
    } finally {
        await database.query(
            "UPDATE schema_migrations SET digest=$1 WHERE name='0001_sqlite_sync.sql'",
            [original],
        );
    }
    await migrate(database);
});

test("queued requests cannot write after a session revocation commits", async () => {
    const user = await register();
    const document = await publish(user);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const holder = transaction(database, async (client) => {
        await client.query("DELETE FROM auth_sessions WHERE user_id=$1", [
            user.userId,
        ]);
        enter();
        await gate;
    });
    await entered;
    const pending = sync(user, [answerEvent(user.deviceId, document)]);
    release();
    await holder;
    const response = await pending;
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(
        (
            await database.query(
                "SELECT count(*) AS count FROM answers WHERE user_id=$1",
                [user.userId],
            )
        ).rows[0]!.count,
        "0",
    );
});

test("review ordering normalizes timestamps with explicit UTC offsets", async () => {
    const user = await register();
    const device = await login(user);
    const document = await publish(user);
    const later = answerEvent(user.deviceId, document, {
        at: "2026-01-02T10:00:00.000Z",
        points: 0,
    });
    const earlier = answerEvent(device.deviceId, document, {
        at: "2026-01-02T11:00:00.000+02:00",
        points: 1,
    });
    assert.equal((await sync(user, [later])).statusCode, 200);
    const response = await sync(device, [earlier]);
    assert.equal(response.statusCode, 200, response.body);
    const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });
    const first = scheduler.next(
        TypeConvert.card(document.sets[0]!.cards[0]!.fsrsData),
        new Date(earlier.payload.answer.answeredAt),
        3,
    ).card;
    const expected = scheduler.next(
        first,
        new Date(later.payload.answer.answeredAt),
        1,
    ).card;
    assert.deepEqual(
        response.json().catalog.sets[0].cards[0].fsrsData,
        JSON.parse(JSON.stringify(expected)),
    );
});
