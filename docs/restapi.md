# Obstudy public API

The public API is served by `service/` and uses a separate private SQLite owner in
`database-service/`. Client endpoints, user authentication, browser cookies and
sync payloads are unchanged. Neither native app connects to the private service.

- [API contract](../service/docs/api.md)
- [Phone web app](../service/docs/web-app.md)
- [Separate SQLite service and Railway cutover](database-service.md)
- [Environment configuration](environment.md)
- [Database owner internals](../database-service/docs/service.md)

Start the database owner before the public gateway. The gateway needs
DATABASE_SERVICE_URL and the same private DATABASE_SERVICE_TOKEN. Registration,
session settings, SQLite migrations and backups now belong to database-service/.
