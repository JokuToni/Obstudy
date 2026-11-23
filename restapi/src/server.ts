import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function start(): Promise<void> {
    const config = loadConfig();
    const app = buildApp(config);
    let stopping = false;

    async function shutdown(): Promise<void> {
        if (stopping) return;
        stopping = true;
        app.log.info("Stopping API");
        try {
            await app.close();
        } catch (error) {
            app.log.error({ err: error }, "Unable to close API");
            process.exitCode = 1;
        }
    }
    process.once("SIGINT", () => {
        void shutdown();
    });
    process.once("SIGTERM", () => {
        void shutdown();
    });

    try {
        await app.listen({ host: config.host, port: config.port });
    } catch (error) {
        app.log.error({ err: error }, "Unable to start API");
        await app.close();
        process.exitCode = 1;
    }
}

start().catch((error: unknown) => {
    console.error(
        error instanceof Error ? error.message : "Unable to start API",
    );
    process.exitCode = 1;
});
