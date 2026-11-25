# Obstudy phone web app

The shared phone interface and public gateway live in service/. The SQLite owner
runs separately in database-service/. The public domain and iPhone installation
flow stay the same.

See [the service's web app guide](../service/docs/web-app.md) for development,
installation, offline behavior and UI checks. Before deploying the database
separation, follow [the cutover guide](database-service.md) to preserve existing
accounts, sessions and study history.
