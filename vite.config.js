import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
    plugins: [tailwindcss(), sveltekit()],
    cacheDir: mode === "web" ? "node_modules/.vite-web" : "node_modules/.vite",

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 1420,
        strictPort: true,
        proxy:
            mode === "web"
                ? {
                      "/v1": {
                          target:
                              process.env.WEB_DEV_API_TARGET ||
                              "http://127.0.0.1:3000",
                      },
                  }
                : undefined,
        host: host || "127.0.0.1",
        hmr: host
            ? {
                  protocol: "ws",
                  host,
                  port: 1421,
              }
            : undefined,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: [
                "**/src-tauri/**",
                ...(mode === "web"
                    ? ["**/.svelte-kit/**", "**/build/**"]
                    : ["**/.svelte-kit-web/**", "**/build-web/**"]),
            ],
        },
    },
}));
