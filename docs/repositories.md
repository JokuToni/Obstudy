# API repository and submodule

The API lives in the private repository
[Obstudy-restapi](https://github.com/JokuToni/Obstudy-restapi). Obstudy includes a
pinned checkout at `restapi/` through Git submodules. The API's earlier commits
were extracted with their history. Its files are no longer tracked individually
by the parent repository; Obstudy tracks the selected API commit instead.

Clone with the API included:

```sh
git clone --recurse-submodules https://github.com/JokuToni/Obstudy.git
```

For an existing checkout:

```sh
git submodule update --init --recursive
npm --prefix restapi ci
```

Access to the private API repository is required. A submodule normally checks out
a detached commit. Before editing the API, switch to its main branch:

```sh
cd restapi
git switch main
git pull --ff-only origin main
```

Run API checks and commit API changes inside `restapi/`. Push the API commit before
publishing a parent commit that references it. Back in Obstudy, stage `restapi` and
commit the updated pointer. Parent and API commits are separate operations; a push
of the parent does not push API commits.

To update the parent checkout to the latest published API main branch:

```sh
git submodule update --remote --merge restapi
git add restapi
```

Review and commit the resulting pointer change. Ordinary clones and CI should use
`git submodule update --init --recursive` to reproduce the pinned version rather
than automatically tracking the newest API commit.

Local dependencies, build output, SQLite files, and environment files remain
ignored within the API repository. The shared Obstudy `.env` still works when the
API is embedded; a standalone API checkout can use its own `.env`. See
`restapi/docs/api.md` for the API contract and standalone setup.

For Railway, connect **Obstudy-restapi** directly, allow the Railway GitHub app to
access that private repository, and set Root Directory to `/`. Its Dockerfile is
at the repository root. Existing volume and database settings stay the same; keep
the volume attached to the existing service when changing its source repository.
Set the health check to `/ready` and deploy the API repository's main branch.
