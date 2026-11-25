# Shared environment configuration

The repository-root `.env` is the shared local configuration file. It is ignored
by Git. The tracked root `.env.example` contains safe defaults for a fresh checkout:

```sh
cp .env.example .env
```

Vite/SvelteKit reads this file from the project root for desktop, iOS, and browser
frontend builds. `PUBLIC_API_BASE_URL` configures desktop and iOS sign-in and study-data sync.
It is compiled into static app builds; see `docs/cloud-sync.md` for setup.
Do not put credentials in variables prefixed with `PUBLIC_` or `VITE_`, because
those prefixes are intended for client-visible configuration. API tokens and vault
paths continue to use the existing device-specific storage.

The API's `dev`, `start`, and `migrate` scripts load `../.env` first and then an
optional `service/.env` for service-local overrides. Shell/hosting environment
variables override both. A fresh setup only needs the root file; the service-local
example remains available for independent API deployments. API scripts run with
`service/` as their working directory, so the default relative DATABASE_PATH
continues to resolve to `service/data/obstudy-api.db`.

```sh
# From the repository root:
npm --prefix service run dev
npm run dev
```

Initialize the API submodule first with `git submodule update --init --recursive`
when using a fresh checkout. These are separate processes. The shared file does not start the API automatically.
Restart each development process after editing environment configuration. Public
frontend values are compiled into builds, so rebuild when changing them for release.

Docker Compose 2.24+ loads the optional root `.env` and then an optional
`service/.env`, so a standalone API checkout also works:

```sh
docker compose -f service/compose.yaml up --build -d
```

Compose fixes the container's HOST to 0.0.0.0, internal PORT to 3000,
DATABASE_PATH to /app/data/obstudy-api.db, and NODE_ENV to production. Other values
come from the shared file. The published port remains localhost:3000 and data
persists in its named volume. Edit Compose's port mapping if you need a different
published port. HTTPS routing is configured separately on the deployment host.

A hosting service building only `service/` should inject environment variables
through its configuration. The root `.env` is outside that Docker build context
and is never copied into the image. No secrets are included in the example file.

## Hosted phone web app

The installable web build uses its own origin for /v1 requests, regardless of
PUBLIC_API_BASE_URL. WEB_ORIGIN configures the API's allowed browser origin; use
the exact HTTPS address without a trailing slash (HTTP localhost is allowed for
development). WEB_DIRECTORY optionally points to compiled static files. The service
Dockerfile sets it to /app/public. The service Docker context excludes local .env files.
Railway deploys the self-contained service repository, using runtime variables,
not the local .env. See [web-app.md](web-app.md) for setup.
