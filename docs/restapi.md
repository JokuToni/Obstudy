# Obstudy REST API

The independent Node.js 24 / TypeScript / Fastify service in `service/` persists
accounts, device sessions, library versions, graded answers, review history, and
sync events in SQLite. Desktop and iOS local databases remain independent.
The API does not read a vault or store AI-provider credentials.

## Run locally

```sh
cd service
npm ci
cp .env.example .env
npm run dev
```

The server creates `service/data/obstudy-api.db` by default. Set `DATABASE_PATH` in
`.env` to choose a different file. This is the server database, separate from each
app's local database. No external database service is required. Node's built-in
`node:sqlite` handles storage.

Migrations run on startup in an immediate SQLite transaction. `npm run migrate`
applies them explicitly. Applied migration checksums are verified; add new SQL
files rather than editing applied migrations.

The default API address is `http://127.0.0.1:3000`. `GET /health` checks liveness;
`GET /ready` checks database access and migration initialization. API requests use
JSON. Machine-readable request schemas are available at `GET /openapi.json`.

```sh
npm run check
npm run build
npm start
```

`HOST`, `PORT`, `LOG_LEVEL`, `DATABASE_PATH`, `REGISTRATION_ENABLED`, `SESSION_DAYS`,
and `CORS_ORIGINS` are configured through environment variables or `.env` (existing
environment values take precedence). Registration defaults to disabled when the
variable is absent. The example enables it for account creation. Session lifetime
is 1–90 days, default 30. CORS takes comma-separated exact allowed origins.

## Accounts and devices

Register or log in with the same body:

```http
POST /v1/auth/register
Content-Type: application/json

{
    "email": "you@example.com",
    "password": "a-password-at-least-12-characters",
    "deviceId": "your-persisted-device-id",
    "deviceName": "My iPhone"
}
```

Registration returns HTTP 201; `POST /v1/auth/login` returns 200. Both return:

```json
{
    "token": "opaque-session-token",
    "tokenType": "Bearer",
    "expiresAt": "2026-12-24T12:00:00.000Z",
    "userId": "account-uuid",
    "deviceId": "your-persisted-device-id"
}
```

Use `Authorization: Bearer <token>` on every `/v1` request except registration and
login. Store tokens in device-protected credential storage. The server persists
only token hashes; passwords use salted scrypt (N=65536, r=8, p=1). Tokens survive
API restarts until expiry or revocation. Expired sessions require another login.

| Method | Route               | Behavior                                                        |
| ------ | ------------------- | --------------------------------------------------------------- |
| GET    | `/v1/me`            | Returns `user` (id, email, created_at) and current deviceId     |
| GET    | `/v1/devices`       | Lists devices, names, creation and last-sync/login times        |
| DELETE | `/v1/devices/:id`   | Removes that device and revokes all its sessions                |
| POST   | `/v1/auth/logout`   | Revokes the current session                                     |
| POST   | `/v1/auth/password` | Takes currentPassword and newPassword; revokes all sessions     |
| DELETE | `/v1/me`            | Takes password; permanently deletes account and all server data |

Successful destructive operations return HTTP 204. Removing a device retains its
study history. Account deletion removes everything, including saved review events.
Email delivery, email verification, password recovery, and third-party login are
not part of this self-hosted account implementation.

## Publish and download the library

`PUT /v1/library` takes:

```json
{
    "baseRevision": null,
    "catalog": { "schemaVersion": 1, "revision": "local-v1", "sets": [] }
}
```

The catalog shape matches `MobileCatalog` in `src/lib/mobile/types.ts`: portable
note titles, topics, questions, and FSRS cards without vault paths. The server
validates references, question formats, unique IDs, card values, and timestamps.
Every basic question needs exactly one card. Sample libraries are rejected.

`baseRevision` is null only for the first upload. For subsequent uploads, use the
exact revision from the last server catalog. The server returns `{ "catalog": ... }`
with its own opaque revision. HTTP 409 means another upload or review changed the
account; download again and reconcile before retrying. Do not automatically retry
with a newer base revision while reusing an older library snapshot.

`GET /v1/library` returns the same response shape with current authoritative cards,
or 404 when no library exists. An empty `sets` list removes all active notes.
Previous versions and historical answers remain available for offline sessions.
Existing card schedules survive subsequent library uploads, removal, and readding.

Question IDs identify immutable question content. Changed question text, format,
choices, example answers, or grading criteria require a new ID. Topic assignment
and summary statistics may change without a new question ID. Historical answers
keep their original question/topic snapshot. Library uploads seed new cards but
cannot reset existing server schedules. A schedule-reset operation is intentionally
not exposed by the library endpoint; use POST /v1/cards/reset instead.

## Sync

`POST /v1/sync` implements the mobile exchange contract:

```json
{
    "schemaVersion": 1,
    "deviceId": "your-persisted-device-id",
    "cursor": null,
    "events": []
}
```

Each event has id, deviceId, occurredAt (ISO timestamp), catalogRevision (the exact
server revision used by its session), kind, and payload. Kinds match `MobileEvent`:

- `answer.graded`: noteId, graded answer, and its published question snapshot.
- `review.applied`: answerId, exerciseId, and the provisional client review.
- `session.closed`: exerciseId, noteId, and all saved graded answerIds.

Answers require exerciseId and mode (`study` or `practice`), a grade of 0, 0.5, or 1,
and a valid timestamp. Multiple-choice answers use the selected choice text; the
server verifies correctness. Free-text answers can include the existing versioned
drawing shape. Empty answers are rejected. Event/answer times may be at most five
minutes ahead of the server clock. IDs are stable ASCII identifiers, max 200 chars.

A batch accepts up to 500 events, resolving answer/review/close dependencies even
when array order differs. Events depending on a missing answer must include that
answer or wait until it has synced. Closing a session must list all its saved
answers. Closed sessions and saved answers cannot be edited. The whole batch is
atomic: no events are acknowledged on a validation/conflict/storage failure.

Response:

```json
{
    "cursor": "42",
    "acknowledgedIds": ["accepted-event-id"],
    "catalog": {
        "schemaVersion": 1,
        "revision": "opaque-server-revision",
        "sets": []
    },
    "events": [{ "sequence": "42", "event": {} }],
    "hasMore": false
}
```

The catalog is omitted until a library has been published. Retries with the same
event IDs and content are acknowledged without duplicating answers or reviews.
Reusing an ID with different content returns 409. Events and catalog access are
scoped to the authenticated account; the request and event device IDs must match
the session device. All sequences and cursors are decimal strings, not JS numbers.

`events` contains up to 500 account events after the supplied cursor, including
other devices' events. While `hasMore` is true, repeat with the returned cursor;
an empty outgoing batch is allowed. Advance a local cursor only after persisting
its page. A cursor beyond the account's current position returns 409. A null cursor
replays from the beginning. Returned catalogs contain the latest schedules even if
the event feed is paginated. Original event review cards are provisional and must
not overwrite those schedules. Use `/v1/reviews` for canonical review logs.

Desktop and iOS consume acknowledgements, paginated answer events, and canonical
catalogs through Account and sync. See docs/cloud-sync.md for app setup and the
API 1.1.0 history-import and schedule-reset additions.

## FSRS and history

The server pins ts-fsrs 5.4.2, retention 0.9, and fuzz disabled, matching the apps.
Study basic-question grades map 0 → Again, 0.5 → Hard, 1 → Good. A graded Study
answer schedules automatically, even if a review.applied event arrives later.
Practice answers never affect cards. Client before/after cards and logs are not
trusted as the final schedule.

For each affected question the server replays all its Study answers from the
original imported card, ordered by normalized UTC answeredAt and then answer ID (binary order).
Late offline answers therefore produce the same schedule regardless of upload
order. Canonical logs are rebuilt in the same transaction. An answer before the
imported card's last_review is rejected with 409: the imported card is the history
baseline, not a replacement for importing older desktop history. Device clocks
must be reasonably accurate; timestamps remain the chosen offline ordering policy.

| Route                               | Response                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/answers?after=0&limit=100` | answers: [{sequence, noteId, answer, question}], cursor, hasMore |
| `GET /v1/reviews?after=0&limit=100` | reviews: [{sequence, answerId, review}], cursor, hasMore         |

Page limits are 1–500. Each endpoint's cursor is independent of the sync cursor.
Late reviews can recalculate earlier canonical logs, so reload review history when
reconciling schedules rather than treating these log pages as an update feed.

## Deployment

The API runs directly with `npm run build && npm start`. With Docker installed,
`docker compose up --build -d` runs a single API container with a persistent SQLite
volume at `/app/data`. Its published port binds to localhost. Place an HTTPS
reverse proxy in front of port 3000 for remote devices. The container runs as an
unprivileged user and exposes `/ready` as its health check.

Use a local persistent disk and one API process. SQLite uses WAL, foreign keys,
full synchronous writes, and a 5-second busy timeout. A request queue serializes
reads and transactions so async password hashing cannot interleave another
request inside an open transaction. Transactions use BEGIN IMMEDIATE. Back up via
the SQLite backup API or stop the API before copying its database; copying only
a live `.db` file can omit data still in its WAL. Backups contain private study
history and credential hashes. Test restoring a backup before relying on it.

Disable registration after creating your account for a private deployment. The
service currently uses an in-memory IP rate limiter: 120 requests/minute generally,
10/minute per sensitive auth route. Forwarded IP headers are not trusted. Behind
a proxy this limits by proxy address; configure a specific trusted proxy boundary
and a shared rate-limit store before running multiple replicas. Do not enable
blanket trust of arbitrary forwarding headers. Responses with account data use
Cache-Control: no-store, and authorization/cookie headers are redacted from logs.

Default body limit is 1 MiB; library and sync requests allow 10 MiB. Remote HTTPS
image references are validated but not fetched or cached by this server. There is
no media hosting, push notification service, or background sync worker.
Docker files are supplied, but Docker execution must be validated on a host with
Docker installed. The Node service itself is integration-tested against on-disk SQLite.

## Integration tests

Run from `service/`:

```sh
npm test
```

Tests create a temporary SQLite file and remove only their own temporary directory
after closing the app. No external database or test connection URL is required.
They exercise authentication/revocation, tenant isolation, migration checksums,
library conflicts, concurrent duplicate uploads, batch rollback, event paging,
late-review replay, persistence across service restart, and account deletion.
