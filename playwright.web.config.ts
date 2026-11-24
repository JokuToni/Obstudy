import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/web",
    outputDir: "./test-results-web",
    fullyParallel: false,
    workers: 1,
    timeout: 60000,
    use: {
        baseURL: "http://127.0.0.1:1455",
        serviceWorkers: "allow",
        trace: "retain-on-failure",
    },
    projects: [
        { name: "webkit", use: { ...devices["iPhone 13"] } },
        { name: "chromium", use: { ...devices["Pixel 7"] } },
    ],
    webServer: {
        command:
            "npm run build:web && npm --prefix restapi run build && node tests/web/server.mjs",
        url: "http://127.0.0.1:1455/ready",
        reuseExistingServer: false,
        timeout: 180000,
    },
});
