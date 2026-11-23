import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Database, Connection } from "./database.js";
import type { ServerConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { healthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./auth.js";
import { registerDataRoutes } from "./routes/data.js";
import { apiSpecification } from "./specification.js";

export function buildApp(
    config: ServerConfig,
    database: Database = createDatabase(config),
) {
    const app = Fastify({
        logger: {
            level: config.logLevel,
            redact: ["req.headers.authorization", "req.headers.cookie"],
        },
        bodyLimit: 1024 * 1024,
        requestTimeout: 30_000,
        forceCloseConnections: "idle",
        // Forwarded client IPs are not trusted; configure the proxy boundary before scaling.
        trustProxy: false,
    });
    app.decorateRequest("userAuth", null);
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ZodError)
            return reply.code(400).send({
                error: "Invalid request",
                issues: error.issues.map(({ path, message }) => ({
                    path,
                    message,
                })),
            });
        const typed = error as {
            statusCode?: number;
            code?: string;
            errcode?: number;
        };
        if ([1555, 2067].includes(typed.errcode ?? 0))
            return reply
                .code(409)
                .send({ error: "This account or record already exists." });
        if ([5, 6].includes((typed.errcode ?? 0) & 255))
            return reply
                .code(503)
                .send({ error: "Storage is busy. Please retry." });
        const statusCode = typed.statusCode ?? 500;
        if (statusCode >= 500) {
            request.log.error({ err: error }, "Request failed");
            return reply.code(500).send({ error: "Internal server error" });
        }
        return reply.code(statusCode).send({
            error: error instanceof Error ? error.message : "Request failed",
        });
    });
    app.addHook("onSend", async (request, reply) => {
        if (request.url.startsWith("/v1/"))
            reply.header("Cache-Control", "no-store");
    });
    app.addHook("onClose", async () => {
        await database.close();
    });
    app.register(cors, {
        origin: config.corsOrigins,
        credentials: false,
        methods: ["GET", "POST", "PUT", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
    });
    app.register(helmet);
    app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
    app.register(healthRoutes);
    app.get("/ready", async (_request, reply) => {
        try {
            const result = await database.query(
                "SELECT 1 FROM schema_migrations WHERE name='0001_sqlite_sync.sql'",
            );
            if (!result.rowCount)
                return reply.code(503).send({ status: "unavailable" });
            return { status: "ok" };
        } catch {
            return reply.code(503).send({ status: "unavailable" });
        }
    });
    app.get("/openapi.json", async () => apiSpecification);
    app.register(async (routes) => {
        await registerAuthRoutes(routes, database, config);
        await registerDataRoutes(routes, database);
    });
    return app;
}
