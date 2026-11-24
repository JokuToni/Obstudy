# Phone web app

Obstudy's mobile study client can run as a Progressive Web App (PWA), installed
from Safari without Apple membership or signing. The desktop remains Tauri; the
native iOS target remains available. The phone offers Study, Practice, saved
questions, text/multiple-choice answers, self grading, results and resumable
sessions. It does not edit vaults, generate questions or configure AI providers.

## Install on your iPhone

After deployment, open the service's HTTPS domain in Safari. Sign into the same
account as desktop, then allow the library to synchronize. Safari's Share menu →
Add to Home Screen installs the app. Open the Home Screen icon and sign in there
if Safari and the installed app use separate browser storage. Wait for “Ready for
offline practice” before relying on it without a connection.

A deployment makes the next app version available when the home screen checks for
updates. Choose Update app from the study-set screen to activate it. No update
button appears during a session, and activating an update requires closing other
Obstudy tabs. Old open tabs keep their cached version until it is safe to replace
it. This is code delivery, separate from normal question/answer synchronization.

## Local verification

Use Node 24. Initialize the private API submodule and install both sets of
packages if this is a fresh checkout:

```sh
git submodule update --init --recursive
npm ci
npm --prefix restapi ci
npm run build:web
WEB_DIRECTORY=../build-web WEB_ORIGIN=http://127.0.0.1:3000 npm --prefix restapi run dev
```

Open http://127.0.0.1:3000. The explicit shell values override local .env defaults.
Keep local databases separate from production. `npm run build:web` creates a
mobile-only route build in build-web/ and generates its versioned service worker.
Web and native builds use separate generated directories and outputs, so building
the web app does not overwrite a running desktop development session.

For live UI development, run `WEB_ORIGIN=http://127.0.0.1:1420 npm --prefix restapi run dev`
and `npm run dev:web` in separate terminals. Open http://127.0.0.1:1420. Vite proxies
/v1 to http://127.0.0.1:3000; override WEB_DEV_API_TARGET in the frontend command's
environment if the local API uses another port. A Vite development build registers
no worker; the bundled local setup above exercises actual offline behavior.

Run checks with:

```sh
npm run check
npm run test:unit
npm --prefix restapi run check
npm --prefix restapi test
npx playwright install chromium webkit
npm run test:web
```

Web browser tests build and serve the actual frontend through Fastify on port
1455 with a temporary SQLite database. They exercise cookie login across reloads,
offline grades, reconnection/FSRS, sign-out, and deferring updates during practice
and while other tabs are open. They never contact the hosted service.

## Railway and GitHub deployment

The root Dockerfile builds the phone frontend and the pinned API submodule,
then serves both through one Node/Fastify process. / serves the app; /v1/* keeps
the existing API contract. No SvelteKit Node server is required. Standalone API
builds still work without the frontend. The API submodule's Dockerfile stays
API-only; use the parent Dockerfile for the combined service.

Configure the existing Railway service once:

1. Back up its SQLite database and keep the existing persistent volume attached.
   Keep DATABASE_PATH pointed to that volume. Do not create an empty replacement
   database while changing the build source.
2. Disable automatic deployments from Obstudy-restapi. Deployments will come from
   the parent repository's GitHub Actions workflow, so an API-only deployment
   cannot accidentally remove the web app.
3. Set the service root to / and Dockerfile path to Dockerfile. Remove obsolete
   build-command overrides. The container's default start command runs the API.
4. Set WEB_ORIGIN to the service's exact public HTTPS origin, for example
   https://your-service.up.railway.app (no trailing slash or /v1). The root image
   sets WEB_DIRECTORY=/app/public. Keep HOST=0.0.0.0 and Railway's supplied PORT.
5. Keep /ready as the health check. Keep REGISTRATION_ENABLED consistent with
   whether you want to allow new accounts; disable it after creating your own.
6. Create a Railway project token scoped to this service's environment.

In the parent GitHub repository, create a production environment and configure
these Actions secrets and variables (repository-level values also work). Set
WEB_DEPLOY_ENABLED as a repository-level variable, since it gates creation of the
production job:

| Kind     | Name                 | Value                                                                                                        |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Secret   | API_REPOSITORY_TOKEN | Fine-grained GitHub token with Contents: read for both private repositories; required for recursive checkout |
| Secret   | RAILWAY_TOKEN        | Railway project/environment token                                                                            |
| Variable | RAILWAY_SERVICE_ID   | Existing service ID from Railway                                                                             |
| Variable | WEB_ORIGIN           | The same HTTPS origin configured on Railway                                                                  |
| Variable | WEB_DEPLOY_ENABLED   | true, after completing the setup                                                                             |

`.github/workflows/deploy-web.yml` checks out the exact API submodule, runs type,
unit, API and Chromium web checks, then uploads the combined source to the existing
Railway service using the CLI. Railway builds the root Dockerfile. Push the API
commit first, then commit/push the updated submodule pointer and app changes to
parent main. Subsequent main pushes deploy automatically; workflow_dispatch
allows retrying manually. An API-only repository push needs a parent pointer update
to become part of this combined deployment.

The workflow is disabled until WEB_DEPLOY_ENABLED=true. No production service,
GitHub secrets or deployments are changed by merely adding these project files.
Local .env, private notes, databases and build caches are excluded from uploads
and the Docker context. PUBLIC_API_BASE_URL remains for the native apps; the web
build always uses its own origin and needs no baked-in service address.

Deployment reference: [Railway CLI deployment](https://docs.railway.com/cli/deploying).

## Authentication and offline data

Browser login has separate /v1/web/auth/register, login, session and logout
endpoints. The server stores a hash of its random session credential; the browser
receives it only as an HttpOnly, Secure, SameSite=Strict, host-only cookie. HTTPS
uses the __Host-obstudy_session name. HTTP localhost development uses a plain
obstudy_session cookie. Native clients continue using Bearer authentication and
Keychain. Browser session tokens cannot be used as native bearer credentials.

Browser write requests require the exact configured Origin and X-Obstudy-Web: 1.
Cookie-authenticated data requests additionally require X-Obstudy-Account to match
the session, preventing another tab's account switch from mixing users' answers.
Cross-origin cookie requests are not enabled. Browser logout needs a connection
so the server can revoke the session and clear its HttpOnly cookie; failure keeps
the account visible rather than pretending it was revoked.

Non-secret account metadata is stored locally to reopen the correct offline
cache. Study data and the durable answer outbox use account-scoped IndexedDB.
The service worker caches only public app files, including local KaTeX assets,
never /v1 responses or authentication data. Grades remain queued until the API
acknowledges them; reconnecting synchronizes canonical FSRS schedules.

Signing out retains the account's local data for later sign-in and retry. Clearing
website data or deleting the installed web app may remove unsynchronized answers.
The app requests persistent storage where supported, but browser storage is not a
backup. Remote question images require a network connection; they are not cached.
