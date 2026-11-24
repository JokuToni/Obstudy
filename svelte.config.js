// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const webBuild = process.env.OBSTUDY_WEB === "1";

/** @type {import('@sveltejs/kit').Config} */
const config = {
    preprocess: vitePreprocess(),
    kit: {
        outDir: webBuild ? ".svelte-kit-web" : ".svelte-kit",
        files: {
            routes: webBuild ? "src/webRoutes" : "src/routes",
        },
        adapter: adapter({
            pages: webBuild ? "build-web" : "build",
            assets: webBuild ? "build-web" : "build",
            fallback: "index.html",
        }),
    },
};

export default config;
