import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { healthRoutes } from "./routes/health.js";

/** Build independently of the listening socket for tests and future integrations. */
export function buildApp(config: ServerConfig) {
    const app = Fastify({
        logger: {
            level: config.logLevel,
            redact: ["req.headers.authorization", "req.headers.cookie"],
        },
        bodyLimit: 1024 * 1024,
        requestTimeout: 30_000,
        forceCloseConnections: "idle",
    });

    app.setErrorHandler((error, request, reply) => {
        const statusCode =
            error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
                ? error.statusCode
                : 500;
        if (statusCode >= 500) {
            request.log.error({ err: error }, "Request failed");
            return reply.code(500).send({ error: "Internal server error" });
        }
        return reply.code(statusCode).send({
            error: error instanceof Error ? error.message : "Request failed",
        });
    });
    app.register(healthRoutes);
    return app;
}
