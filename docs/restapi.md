# REST API

`restapi/` is an independent Node.js 24.10+ (24.x) TypeScript/Fastify service with
its own package manifest and lockfile. Installing or building the desktop app does
not install or start the API.

From the repository root:

```sh
cd restapi
npm ci
cp .env.example .env
npm run dev
```

The defaults are `HOST=127.0.0.1`, `PORT=3000`, and `LOG_LEVEL=info`. Environment
variables take precedence over `.env`. The server validates these values before
listening. `NODE_ENV` follows the usual Node convention; it does not change the
bind address or enable additional endpoints. `npm run dev` reloads on code changes.

```sh
curl http://127.0.0.1:3000/health
# {"status":"ok"}
```

For a compiled run:

```sh
npm run check
npm run build
npm start
```

`src/app.ts` constructs the Fastify instance without binding a socket;
`src/server.ts` loads configuration, starts listening, and closes on SIGINT/SIGTERM.
Routes live under `src/routes/`. Logs use structured JSON and redact authorization
and cookie headers. Unexpected errors are logged server-side but return a generic
500 response. JSON requests have a 1 MiB limit and a 30-second request-receiving
timeout. The timeout does not limit handler execution time.

Only `GET /health` is implemented. It reports process liveness, not database or sync
readiness. There is no database connection, authentication, library upload, or sync
endpoint yet. The existing desktop and iOS applications are not connected to this
server. No AI credentials or vault contents are read by the API.

The next layer will add PostgreSQL migrations, user/device authentication, and
versioned `/v1/library` and `/v1/sync` routes matching the mobile contract in
`src/lib/mobile/types.ts`. The server will need durable event deduplication and a
defined FSRS conflict policy; see `docs/ios.md`. Configure TLS and the desired bind
address when deployment is implemented. Cross-origin browser development access
can be added with explicit allowed origins when a browser client is connected.
