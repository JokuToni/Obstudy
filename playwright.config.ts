import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/ui",
    use: {
        baseURL: "http://127.0.0.1:1420",
        trace: "retain-on-failure",
    },
    projects: [
        { name: "webkit", use: { ...devices["Desktop Safari"] } },
        {
            name: "chrome",
            use: { ...devices["Desktop Chrome"], channel: "chrome" },
        },
    ],
    webServer: {
        command: "npm run dev -- --host 127.0.0.1",
        url: "http://127.0.0.1:1420",
        reuseExistingServer: !process.env.CI,
    },
});
