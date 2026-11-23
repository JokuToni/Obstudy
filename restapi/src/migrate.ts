import { createDatabase, migrate } from "./database.js";
import { loadConfig } from "./config.js";
const database = createDatabase(loadConfig());
try {
    await migrate(database);
    console.log("Database migrations applied.");
} catch {
    console.error(
        "Database migration failed. Check database connectivity and migration history.",
    );
    process.exitCode = 1;
} finally {
    await database.close();
}
