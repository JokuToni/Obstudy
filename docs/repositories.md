# Obstudy repositories

| Repository                                                                       | Checkout            | Responsibility                                           |
| -------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| [Obstudy](https://github.com/JokuToni/Obstudy)                                   | root                | Native apps and pinned submodules                        |
| [obstudy-service](https://github.com/JokuToni/obstudy-service)                   | `service/`          | Public gateway, phone web app and shared UI              |
| [obstudy-database-service](https://github.com/JokuToni/obstudy-database-service) | `database-service/` | Private SQLite owner, migrations and domain transactions |

Both service repositories are private. The historical submodule name `restapi`
still refers to `service/`; keep its existing entry. The database service has its
own submodule entry. Neither Docker build needs the parent repository or the
other service's checkout at runtime.

```sh
git clone --recurse-submodules https://github.com/JokuToni/Obstudy.git
# Or, in an existing checkout:
git submodule sync --recursive
git submodule update --init --recursive
npm ci
npm --prefix service ci
npm --prefix database-service ci
```

Commit changes inside each service repository, then update the parent's pinned
references. Publish referenced service commits before publishing the parent.
Submodule checkouts can be detached; switch to main before new development.
The service's CI uses a read-only deploy key to check out a pinned database-service
fixture for HTTP/browser integration tests.

The database service owns the persistent Railway volume. The gateway keeps the
existing public domain, serves the web app, and uses DATABASE_SERVICE_URL and
DATABASE_SERVICE_TOKEN to reach the private process. Client API URLs do not change.
Follow [database-service.md](database-service.md) before deploying this refactor,
including moving existing data and configuring Railway variables. The root
compose.yaml starts both locally; service/compose.yaml expects external storage.
