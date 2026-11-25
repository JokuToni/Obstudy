# Obstudy service repository

The private [Obstudy-service](https://github.com/JokuToni/obstudy-service) repository
contains the Fastify API, phone web app, shared study code and complete Docker
build. It was renamed from Obstudy-restapi. This parent repository includes a
pinned checkout at service/; the historical internal Git submodule name remains
restapi, while its path and URL use the new service name.

Clone the native app with shared code included:

```sh
git clone --recurse-submodules https://github.com/JokuToni/Obstudy.git
```

For an existing checkout after pulling the rename:

```sh
git submodule sync --recursive
git submodule update --init --recursive
npm ci
npm --prefix service ci
```

If Git leaves an empty old restapi/ folder after changing revisions, inspect it
before removing it; do not discard any local changes or database files. Git moves
the tracked submodule to service/ in this change. Existing service databases and
local environment files remain ignored and are preserved by the directory move.

Work on backend or phone UI inside service/. Commit there, then update the parent
submodule pointer separately. Push the service commit before publishing a parent
commit that references it. A parent push alone does not publish service changes.
A normal submodule checkout may be detached; switch to main before new edits.

```sh
cd service
git switch main
npm run check
npm test
npm run test:web
```

Railway deploys Obstudy-service directly at Root Directory /. Its Dockerfile
builds the API and frontend without the parent repository. Keep the existing
persistent database volume and service domain. See
[service/docs/web-app.md](../service/docs/web-app.md) for deployment and iPhone
installation. The old parent workflow requiring Railway/GitHub deployment tokens
has been removed; normal service GitHub pushes can trigger Railway auto-deploys.
