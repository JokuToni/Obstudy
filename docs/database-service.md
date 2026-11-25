# Separate SQLite service

The repositories now have these responsibilities:

| Checkout            | Responsibility                                                                          |
| ------------------- | --------------------------------------------------------------------------------------- |
| `service/`          | Public Fastify gateway, phone web app and shared UI                                     |
| `database-service/` | Private domain API, SQLite file, migrations, auth/session records and FSRS transactions |
| Obstudy root        | Native apps and pinned references to both repositories                                  |

The new private repository is
[JokuToni/obstudy-database-service](https://github.com/JokuToni/obstudy-database-service).
Both checkouts are Git submodules. Neither production Docker build needs the
other repository's source: they communicate over authenticated HTTP. Desktop and
phone continue using the same public service URL and /v1 API.

## Local development

```sh
git submodule update --init --recursive
npm ci
npm --prefix service ci
npm --prefix database-service ci
```

The shared root `.env` now includes DATABASE_SERVICE_URL, DATABASE_SERVICE_TOKEN
and DATABASE_PORT. Generate a random token as described in `.env.example`; use
one value for both services, never a PUBLIC_ or VITE_ variable. Existing local
public URLs are preserved. In separate terminals:

```sh
npm run dev:database
npm --prefix service run dev
npm run dev
```

The database service uses port 4000; the gateway uses 3000. DATABASE_PATH resolves
under database-service/ when its npm scripts run. Point it at an existing server
database if needed; do not accidentally create an empty database at a new relative
path. Vault-local native databases are unrelated and remain on the device.

Build database-service before the gateway's end-to-end tests. The root
`npm run test:web` does this automatically. The service repository's browser
fixture uses the sibling checkout by default, or DATABASE_SERVICE_FIXTURE_DIR.
It starts a temporary SQLite owner and a real HTTP gateway, never production.
CI uses a pinned database-service commit and a read-only repository deploy key in
the service repository secret DATABASE_SERVICE_DEPLOY_KEY. Each repository still
runs its own standalone unit/contract checks.

`docker compose up --build` from the Obstudy root runs both services. Only the
public gateway publishes localhost:3000; SQLite persists on the database service's
named volume. A standalone service/compose.yaml connects to an already-running
private database URL. These Compose volumes do not automatically import the old
service/compose.yaml volume.

## Railway cutover without losing data

Prepare these steps before pushing the refactored gateway, because its GitHub push
may automatically deploy. The previously deployed phone UI remains unaffected
until that push. The database repository can be deployed independently first.

1. Create a service from `JokuToni/obstudy-database-service` in the SAME Railway
   project/environment as the existing public service. Use Root Directory `/`, its
   Dockerfile, `HOST=::`, `PORT=4000`, and health-check path `/health`. Keep one
   replica and no public domain. Attach storage at `/app/data`. Set
   RAILWAY_RUN_UID=0 for Railway's root-owned volume, as documented in
   [volume permissions](https://docs.railway.com/volumes).
2. Generate one strong DATABASE_SERVICE_TOKEN and configure the same private value
   on both services. On the database service set
   DATABASE_PATH=/app/data/obstudy-api.db, WEB_ORIGIN to the existing PUBLIC HTTPS
   domain, SESSION_DAYS to the old value, and REGISTRATION_ENABLED as desired.
3. Stop writes to the OLD service during the actual cutover. Stop its process or
   place it in maintenance before taking the final snapshot. Keep its existing
   volume intact. Use SQLite's backup API to create a consistent snapshot,
   including WAL data; the new repository provides `npm run backup -- SOURCE NEW`.
   Copy the snapshot into the stopped database service's volume at DATABASE_PATH,
   with owner/permissions matching its node user. Do not copy only a live .db file,
   and do not attach one writable SQLite volume to both running services.
4. Start the database service. Startup verifies existing migration checksums and
   applies any pending migrations. All four existing files are unchanged. Verify
   its authenticated `/ready` and a test of an EXISTING account through a staging
   gateway before completing cutover. Do not reset passwords or recreate accounts.
5. Set DATABASE_SERVICE_URL on the public gateway to
   `http://<database-service-name>.railway.internal:4000` and the matching token.
   Keep its existing public domain and CORS_ORIGINS. It no longer needs a mounted
   database volume, DATABASE_PATH, migration commands, or registration/session
   settings. Remove any old pre-deploy `npm run migrate` command from the gateway;
   migrations now run only in the database process.
6. Publish/deploy the refactored gateway. Its `/ready` succeeds only when it can
   authenticate to the database service and its migrations are initialized. Verify
   existing desktop login, phone cookie restoration, library download and one
   answer sync. Keep the old volume and snapshot for rollback; do not delete them.

If rollback is needed before new writes, restore the old gateway build against
its untouched volume. After new writes, stop both processes and transfer a fresh
consistent snapshot back before rollback, so recent study history is preserved.

Railway internal DNS and network isolation are documented in
[Private networking](https://docs.railway.com/networking/private-networking).
The refactor does not automatically move a hosted volume or change Railway
configuration. The gateway intentionally fails startup without its database URL
and private token, rather than silently creating a new SQLite file.
