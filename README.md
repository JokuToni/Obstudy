# Obstudy

A desktop study application built around Obsidian notes.

## Stack

- Tauri 2, Rust, Svelte 5, TypeScript, SvelteKit (static SPA), and Vite
- Tailwind CSS through its Vite plugin, with global styles in `src/app.css`
- SQLite through the Tauri SQL plugin
- Tauri dialog and filesystem plugins for selecting and reading a notes folder
- OpenAI SDK, CodeMirror 6, KaTeX, and ts-fsrs

Only the application foundation is implemented. Study workflows, database migrations,
AI requests, and editor integrations will be added separately.

## Development

Install Node.js and the platform prerequisites from
https://v2.tauri.app/start/prerequisites/, including Rust and Cargo.

```sh
npm ci
npm run tauri dev
```

For a browser-only preview, run `npm run dev`. Native plugins require Tauri.

```sh
npm run check
npm run build
npm run format:check
npm run tauri build
```

Use `npm run format` to format frontend files with four spaces.
Use `cargo fmt --manifest-path src-tauri/Cargo.toml` for Rust formatting.

## Project layout

- `src/routes`: Svelte application entry and pages
- `src/lib`: shared frontend code as features are introduced
- `src-tauri/src`: native application entry and plugin registration
- `src-tauri/capabilities`: native API permissions
- `1details/project.md`: local project requirements

The filesystem plugin is registered with read operations only. Folder access will be
granted through the native folder picker when that workflow is implemented.
The SQL plugin is registered; the application schema is not defined yet.
The OpenAI SDK is installed but no client or API key is configured.
Never place API keys in Vite public environment variables or committed source files.
