import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../../restapi/dist/app.js";
import { loadConfig } from "../../restapi/dist/config.js";
import { createDatabase, migrate } from "../../restapi/dist/database.js";

const temporary = mkdtempSync(join(tmpdir(), "obstudy-web-browser-"));
const config = loadConfig({
    DATABASE_PATH: join(temporary, "api.db"),
    REGISTRATION_ENABLED: "true",
    LOG_LEVEL: "silent",
    WEB_ORIGIN: "http://127.0.0.1:1455",
    WEB_DIRECTORY: resolve("build-web"),
});
const database = createDatabase(config);
await migrate(database);
const app = buildApp(config, database);
await app.listen({ port: 1455, host: "127.0.0.1" });
async function stop() {
    await app.close();
    rmSync(temporary, { recursive: true, force: true });
    process.exit();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
