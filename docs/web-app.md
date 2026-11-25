# Phone web app

The complete web app and backend live in the standalone
[Obstudy-service](https://github.com/JokuToni/obstudy-service) repository, checked
out here as the service/ submodule. Its own Dockerfile builds and serves both.
Railway should deploy that repository directly; the former parent deployment
workflow and combined parent Dockerfile have been removed.

See [service deployment and installation instructions](../service/docs/web-app.md).

From this parent checkout, the convenience commands are:

```sh
npm --prefix service ci
npm run build:web
WEB_ORIGIN=http://127.0.0.1:3000 npm --prefix service start
npm run test:web
```

The native apps reuse service/web/src/lib components and study logic. Root
TypeScript forwarding modules and the $study Svelte alias preserve their imports;
there is only one implementation. The web app builds to service/public/, while
native builds still use build/. Desktop-only Obsidian scanning, question
generation, AI integrations and native window handling remain in this repository.
