# Desktop and iOS cloud sync

Both apps use PUBLIC_API_BASE_URL from the project-root .env. It is public,
compiled frontend configuration; rebuild a release when changing it. Native API
requests go through Rust with HTTPS, request timeouts, bounded responses, and no
cross-origin redirects. Bearer tokens stay in the OS credential store (Keychain on
macOS/iOS). Only account metadata reaches the frontend. Browser preview uses
fetch and keeps its token in memory, so reloading the preview requires signing in
again; no token is written to browser localStorage or IndexedDB.

## Connect devices

1. Deploy the updated API first. `/v1/capabilities` reports history-import,
   schedule-reset, and byte-paging support. The API's OpenAPI version is 1.2.0.
   New migrations add historical-import flags and reset tracking; existing data
   is retained. The desktop reports a clear update message against older servers.
2. Set PUBLIC_API_BASE_URL to the server's HTTPS base address, without /v1.
3. Start desktop, choose the existing notes folder, and open Account and sync.
4. Sign in using the account created on the server, then select Sync now. Account
   creation is also available when REGISTRATION_ENABLED permits it.
5. Open the iOS app and sign in to the same account. Its home screen downloads the
   question library and schedules. Select a note and start Study or Practice.

The desktop sync controller belongs to the workspace, so closing the Account and
sync tab does not stop syncing. The default workspace still opens only Overview. Sync runs on sign-in, focus, returning online, local question
changes, saved practice answers, and once per minute while the workspace is open.
The phone syncs on sign-in, focus/online, answer actions and the same periodic
interval. Changes arriving during an active sync are queued for another pass.
Cold-start/network failures retry with bounded backoff; validation and auth errors
are shown directly. Local data remains saved when sync fails.

## Ownership and offline behavior

The API is authoritative for the shared question library, graded answer history,
and canonical FSRS schedules. Desktop still owns local Obsidian scanning, question
generation, AI credentials, practice settings, and the desktop editor/window flow.
These functions do not require uploading the vault itself or AI secrets.

A desktop vault is bound to its first linked account and server. Linking that same
vault to a different account/server is rejected instead of mixing histories. Use
the original account or a separate vault database. Remote notes owned by another
publisher are preserved when this desktop updates its own notes. The API syncs
study data, not Markdown files, Obsidian configuration, or attachments on disk.

The iOS cache is scoped by server and account. Signing out retains unsynced data
on that device; signing back into the same account resumes it. A different account
gets a separate cache and cannot see the previous library through the app. Legacy
sample data remains separate and is never sent to the server. Device IDs come from
the native device identity used at login, not a new random ID on each session.

Desktop publishes portable notes, topics, question snapshots and baseline cards.
The Studying flag is shared: notes outside Studying support Practice but cannot
start a phone Study session. Notes with unresolved parsing/topic issues retain
their last published contents until fixed. Local image paths are not portable;
question images must use HTTPS or embedded image data supported by the API.

## Data integrity

Native background snapshots read a lightweight library plus unsent answer/session
deltas; they do not reload all past drawings or exercise snapshots every minute.
History indexes and targeted card/statistic updates keep routine sync work local
to changed questions. New desktop outbox events and their immutable IDs are saved
before transmission.
The API acknowledges durable events; clients commit those acknowledgements and
downloaded pages locally before advancing their cursor. Phone events are saved
atomically with answers and provisional schedules. Pages are limited by count and
byte size so drawing answers cannot make a history page too large to download.

On the first connection, desktop freezes existing graded history for an idempotent
import. That history is stored without scheduling it again: current desktop cards
are the imported baseline. When a newly generated question is first published after offline study, its
current card is likewise a baseline and its earlier answers are imported once.
Unpublished questions archived before upload retain their answer history without
entering the active library. Subsequent graded Study answers for published
questions use normal event sync and the API replays them in timestamp/ID order. Practice does not reschedule.
Local pending grades protect provisional desktop cards from being overwritten
while a different window is submitting an answer. Once those grades are accepted,
server cards replace the provisional schedule.

Desktop retains the catalog revision and original published question snapshot for
queued answers, so archival, generation, or topic changes cannot rewrite a saved
answer's question. Incoming phone answers join the native answer-history view;
note statistics, streaks, practice selection and calendar calculations read the
combined history without duplicating the desktop's own submissions.

Schedule reset is a durable, idempotent operation. It resets the baseline while
retaining grades and review history. Pre-reset answers arriving late are kept as
history and do not revive the old schedule. Reset operations are persisted inside
the desktop reset transaction and survive network failures and concurrent sync.

## API additions

| Route                   | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| GET /v1/capabilities    | Announces compatible sync features                          |
| POST /v1/history/import | Idempotent pre-connection history import, up to 500 records |
| POST /v1/cards/reset    | Idempotent schedule reset with optimistic catalog revision  |

History import accepts `{records:[{noteId,answer,question}]}`. Reset accepts
`{id,baseRevision,questionIds}` and returns `{catalog}`. Existing /v1/sync request
shapes remain supported. Catalog sets now optionally carry isStudying.

## Verification and development

Run npm run check, npm run test:unit, cargo test --manifest-path src-tauri/Cargo.toml,
and the UI tests. The cloud UI tests start an isolated real SQLite API and exercise
login, history migration, bidirectional progress, retries, and account separation.
No production account is created and no production vault is used by these tests.

For a browser phone preview, use /?mobile-preview. Browser requests require the
preview origin in the server's CORS_ORIGINS. Native requests do not use browser
CORS. A development-only api-preview query parameter can point to a localhost API;
non-local preview overrides are rejected and release builds ignore the parameter.

Both static frontend builds and the desktop Rust core are checked locally. Native
iOS signing, Keychain authorization on a device, and Simulator execution require
full Xcode and must be verified in that environment.

## Phone web client

The installable web target shares the mobile study/sync service. It uses its own
origin, HttpOnly cookie authentication and account-scoped IndexedDB. Preview mode
still uses memory-only bearer tokens; native credentials stay in Keychain. See
[web-app.md](web-app.md) for installation, offline updates and combined deployment.
