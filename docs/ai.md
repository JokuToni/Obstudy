# AI integrations

## Service boundary

Use `src/lib/services/ai.ts` from application code. `promptAi(prompt)` uses the
active integration and returns the same `AiResponse` shape for every provider.
It is a single-turn text request with no prompt retries, tool calls, or provider
fallback. The ChatGPT plan adapter consumes a stream internally and returns only
a completed answer; the service still returns one promise. Adding a provider requires an adapter and extending the
provider enum; views and question-generation code should keep using this service.

The API-key adapters use OpenAI Responses and Anthropic Messages. A separate
`openaiOauth` connection uses the documented Sign in with ChatGPT flow for eligible
plan usage. API-key OpenAI and ChatGPT plan connections can coexist.

## Configure an integration

Open **AI integrations** from the workspace tab picker or the bottom-bar AI
selector. The tab supports adding, editing, selecting, and removing integrations,
loading models, and viewing reported usage. The bottom selector switches the
active integration. These controls use the following service functions:

```ts
import {
    saveAiIntegration,
    selectAiIntegration,
    listAiModels,
    promptAi,
} from "$lib/services/ai";

// apiKey and selectedModel come from the user's integration form.
await saveAiIntegration(
    {
        id: "personal-openai",
        provider: "openai", // or "anthropic"
        model: selectedModel,
        maxOutputTokens: 4096,
    },
    apiKey,
);

const models = await listAiModels("personal-openai");
await selectAiIntegration("personal-openai");
const response = await promptAi("Explain spaced repetition briefly.");
console.log(response.text);
```

`discoverAiModels(provider, apiKey)` lists models before an integration is saved,
without persisting the credential. `listAiModels(id)` uses a saved credential.

The first saved integration is selected automatically. Later saves can change its
selected model, output limit, and optional reasoning effort. There is one integration per connection type and no custom integration name. Omit `apiKey` to keep the saved credential.
IDs are stable application identifiers: 1–128 ASCII letters, digits, underscores or
hyphens. A provider change requires a separate integration so credentials cannot
be accidentally sent to the wrong provider. Models are discovered from the
provider rather than hard-coded; an account-accessible model may not support this
adapter's text endpoint. The provider validates the selected model and its limits.

`getAiConfiguration()` lists configurations and the active integration ID.
`removeAiIntegration(id)` deletes its credential and metadata. Removing the active
integration clears the selection instead of silently choosing another provider.

## Credentials and persistence

HTTP calls run in Rust against fixed official provider endpoints. Redirects are
disabled. API keys are stored in the operating system credential store (Keychain
on macOS); credential operations run on blocking worker threads. Keys are never
returned by the read APIs or saved to SQLite, Tauri Store, or public Vite variables.
Keychain access may require OS approval. No plaintext fallback is provided.

Non-secret integration metadata is persisted in an app-level SQLite database:
`integrations.dev.db` for debug builds and `integrations.db` for release builds,
under Tauri's app configuration directory. On macOS this is
`~/Library/Application Support/com.obstudy.desktop/`. These settings apply to the
app, independently of the selected notes folder; `obstudy.db` retains study data.
Credential-store service names are also separated between development and release.

The `aiIntegrations` table stores provider, model, effort, output limit and a
credential reference. `aiOAuthAccounts` stores issued registration IDs, verified
account information, granted scopes, expiry and a credential reference.
`aiPreferences` stores the selected integration; `aiSettings` stores the stable
OAuth host and registration metadata. No API keys or OAuth tokens are stored in
these tables. Settings updates commit transactionally.

Existing `ai.dev.json` / `ai.json` settings are imported once when the database is
opened. The original files remain intact. The migration marker prevents deleted
integrations from being reimported on later launches. Existing credential-store
references stay the same, so migration does not require logging in again.

## Results, errors, and usage

`AiResponse` contains text, integration ID, provider, the actual model returned by
the API, response ID, token usage, and provider rate-limit headers. OpenAI cached
input is already included in its input-token total. Claude cache-read and
cache-creation input tokens are separate and included in the reported total.

Errors reject with an `AiError` object, including a stable code and message.
Authentication, rate limits, incomplete output, malformed responses, and network
failures are distinct. API failures include HTTP status and rate-limit headers
when available. Raw provider error bodies and request credentials are not exposed.
Truncated or refused responses are not returned as complete answers.

`getLastAiResponse(id)` returns the last successful response in this running app,
including the model used. It is not persistent analytics or an account balance.
Rate-limit headers are snapshots with an `observedAt` Unix timestamp in seconds;
OpenAI and Anthropic reset values retain their provider-specific formats. An
absent header means unknown, not unlimited. Rate limits can be shared with other
applications using the account and can change between calls.

Neither remaining credit nor exact time left is inferred. The integration UI displays provider-reported headers, reset/retry information,
and unknown states. Use Refresh to retrieve the latest successful call recorded
in this app session; it does not issue a new prompt or query live billing. Account billing information belongs in the provider dashboard
unless a dedicated billing integration is implemented.

## Verification

Run `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `npm run check`, and
`npm run build`. Provider request/response tests use local fixtures and make no
paid requests. Real account authentication and model access require a separate
manual check with user-supplied keys or browser sign-in. OAuth tests cover signed
identity validation, callback binding, the loopback listener, model discovery,
request fields, streamed completion and limit failures. Tests do not use a real
ChatGPT account or request paid inference.

## References

- [OpenAI text generation](https://developers.openai.com/api/docs/guides/text)
- [OpenAI response and rate-limit headers](https://developers.openai.com/api/reference/overview)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic model discovery](https://platform.claude.com/docs/en/api/models/list)
- [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)

## ChatGPT plan connection

Select **OpenAI · ChatGPT plan**, choose **Continue with ChatGPT**, and authorize
in the system browser. The native backend immediately records the connected integration and active
selection after persisting validated credentials. After model discovery succeeds,
the form saves the model and refreshes the bottom selector automatically. It keeps the
current model when available, otherwise choosing the first discovered model;
model and effort can be changed and saved afterward. A previously authorized
account without saved integration metadata is completed the same way when its
connection form opens, without requiring another login. Empty or failed model
discovery shows an error instead of creating an unusable integration. Account eligibility and the
granted permission determine whether plan inference is enabled; identity sign-in
alone cannot authorize prompts. A declined plan grant keeps identity sign-in but
disables saving the inference connection until consent is granted.

The native backend generates PKCE, state and nonce, listens on an ephemeral
IPv4 loopback port, and validates the callback before exchanging the code. Issued
client IDs and a stable host identifier are retained separately from credentials.
ID tokens are checked with published signing keys, including issuer, audience,
expiry, nonce, and the returning account identity. Cancellation or timeout closes
the listener; credential persistence starts only after validation. Tokens never
enter the webview, vault database, or plain settings files. The OS credential
store holds the session as one record and replaces refreshed credentials together.

Refresh is serialized in this app process and runs before expiry. Terminal
revocation clears unusable tokens; transient errors retain the session. Sign out
attempts remote revocation and clears local credentials, reporting when remote
revocation could not be confirmed. The issued registration is retained for later
sign-in to the same account. This version supports one connected ChatGPT account;
an account/workspace switcher is not implemented.

Plan inference sends `stream: true`, `store: false`, and array-form input, omitting
unsupported output-limit fields. Only `response.completed` yields an answer;
failed, incomplete and interrupted streams reject the request. Limits never
trigger another billing path. Model choices come from the account's catalog,
filtered to visible entries. Actual inference remains the access check for a
selected model. The UI links to ChatGPT Settings to manage app usage rather than
estimating remaining plan time.

This follows OpenAI's current flow for open-source and locally hosted apps;
distribution through other hosting/commercial arrangements requires checking
OpenAI's applicable onboarding requirements.

- [Sign-in registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Session lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Model discovery and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Request limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Browser interaction regression tests

Install test browsers with `npx playwright install webkit chrome`, then run
`npm run test:ui`. The suite runs against WebKit (matching the macOS webview
engine family) and Chrome. It exercises provider switching, the OAuth login
command and save flow, API-key/model submission, and dropdown keyboard/closing
behavior. Native commands are mocked in these browser tests; they neither store
real credentials nor complete a real account login.

The dropdown must let a pointer selection finish before closing on focus loss.
macOS WebKit can move focus to the enclosing tab panel before dispatching an
option click; closing on that focus event discards the selection. Outside clicks,
Escape, and keyboard focus leaving still close the menu. Arrow keys and Home/End
navigate options independently of macOS's Tab-navigation preference.

## Model selection and effort

The model field is a dropdown populated by account model discovery, including
models loaded after ChatGPT sign-in. It accepts no free-form IDs. Editing an
integration reloads its account catalog; its saved ID remains visible if loading
fails. A successful refresh replaces the choices with the current catalog.

Models include `effortLevels`. The Effort dropdown appears only when this list is
non-empty and offers only those levels plus Model default. Choosing another model
clears the previous override; refreshing capabilities clears an unsupported
choice. The saved `reasoningEffort` is optional, so existing configurations retain
provider defaults. Rust validates non-default settings against discovered
capabilities before saving. OpenAI API and ChatGPT plan requests send
`reasoning.effort`; Anthropic sends `output_config.effort`. Model default omits
the parameter altogether.

Capability handling is centralized in `src-tauri/src/ai/capabilities.rs`.
Anthropic uses the model catalog's per-level `capabilities.effort` flags. ChatGPT
catalog reasoning levels take precedence when provided. OpenAI catalogs without
capabilities use a conservative registry of documented model aliases and dated
snapshots. Unknown models and unverified variants expose no effort override;
add verified mappings as the providers release new models. No effort level is
inferred solely from a model-name prefix.

References: [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning),
[Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort), and
[Anthropic model capabilities](https://platform.claude.com/docs/en/api/models/list).

The bottom bar groups the session mode and AI selector on the left, both 40px
high, with a 12px gap. Start is pushed to the right. Provider labels truncate
within the available toolbar width; resizing retains the single-row layout.

## Restart recovery

Startup loads the integration rows and active selection from SQLite. If an older
version saved a valid OAuth session but never saved its integration metadata,
startup reconstructs a connected integration from the system credential store,
without opening a browser. Recovery preserves an existing active provider. When
no model was ever saved, the connected row shows Choose a model; model selection
is required before prompting, but another login is not required.

The token record retains its refresh token, issued client ID, verified identity,
scopes and expiry across launches. Expiring access tokens are renewed on use;
replacement credentials are written as one credential-store record. Ordinary
shutdown does not sign out, revoke, or clear credentials. Temporary network errors
do not erase the session. Explicit sign-out or terminal provider revocation clears
local credentials while keeping the registration available for later sign-in.

Storage tests close and reopen a real SQLite file and verify selection, all
provider settings, OAuth registration, stable host metadata, transaction rollback
and idempotent legacy migration. Browser tests verify reload without invoking
OAuth login; native calls are mocked, so these are not live account-authentication
tests.
