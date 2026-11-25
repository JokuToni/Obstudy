# Shared environment configuration

The root `.env` is local and ignored by Git. `.env.example` documents the shared
settings; generate a random DATABASE_SERVICE_TOKEN rather than using its sample.
Only PUBLIC_ and VITE_ values may be included in frontend builds. The internal
credential never uses those prefixes and is never sent to phone/desktop clients.

| Process                            | Settings                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Native apps                        | PUBLIC_API_BASE_URL: unchanged public gateway origin                                                                                            |
| Hosted phone app                   | Same-origin /v1 requests                                                                                                                        |
| Public gateway (`service/`)        | HOST, PORT, LOG_LEVEL, CORS_ORIGINS, WEB_DIRECTORY, DATABASE_SERVICE_URL, DATABASE_SERVICE_TOKEN, DATABASE_SERVICE_TIMEOUT_MS                   |
| SQLite owner (`database-service/`) | HOST/PORT or local DATABASE_HOST/DATABASE_PORT overrides, DATABASE_PATH, DATABASE_SERVICE_TOKEN, REGISTRATION_ENABLED, SESSION_DAYS, WEB_ORIGIN |

Both Node repositories load ../.env first and then their own .env; shell/hosting
variables override files. DATABASE_PATH resolves under database-service/ when its
npm scripts run. The gateway no longer reads a database path or applies migrations.
WEB_ORIGIN belongs to the database service and must match the public browser
origin for secure cookies and CSRF checks. For Vite live development, use
http://127.0.0.1:1422 there; for the bundled gateway use http://127.0.0.1:3000.

```sh
npm run dev:database
# Separate terminal:
npm --prefix service run dev
# Separate terminal for the native app:
npm run dev
```

The root `docker compose up --build` starts both containers, publishes only the
gateway on localhost:3000 and stores SQLite on the database container's volume.
Compose passes explicit settings to each process rather than copying .env files
into images. A standalone gateway can use service/compose.yaml with an existing
internal DATABASE_SERVICE_URL; this no longer creates a database volume.

On Railway, inject variables into each service's configuration. Keep the database
service private in the same project/environment and give it the persistent disk.
Set the gateway's URL to its railway.internal address. See
[database-service.md](database-service.md) for existing-data cutover instructions.
Changing PUBLIC_API_BASE_URL still requires rebuilding native releases.
