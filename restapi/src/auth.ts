import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database, Connection } from "./database.js";
import type { ServerConfig } from "./config.js";
import { transaction } from "./database.js";
import {
    credentialsSchema,
    deleteAccountSchema,
    idSchema,
    passwordSchema,
} from "./schemas.js";
import { hashPassword, tokenHash, verifyPassword } from "./security.js";
import { ApiError, requireValue } from "./errors.js";

export interface AuthContext {
    userId: string;
    deviceId: string;
    sessionId: string;
}
declare module "fastify" {
    interface FastifyRequest {
        userAuth: AuthContext | null;
    }
}
export async function authenticate(
    request: FastifyRequest,
    database: Database,
): Promise<void> {
    const authorization = request.headers.authorization;
    requireValue(
        authorization && /^Bearer [a-f0-9]{64}$/.test(authorization),
        "Authentication required.",
        401,
    );
    const result = await database.query(
        "SELECT user_id,device_id,id FROM auth_sessions WHERE token_hash=$1 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [tokenHash(authorization.slice(7))],
    );
    requireValue(result.rowCount, "Session expired or revoked.", 401);
    const row = result.rows[0]!;
    request.userAuth = {
        userId: row.user_id,
        deviceId: row.device_id,
        sessionId: row.id,
    };
}
/** Recheck the session inside the serialized write transaction. */
export async function lockUser(client: Connection, auth: AuthContext) {
    const result = await client.query("SELECT * FROM users WHERE id=$1", [
        auth.userId,
    ]);
    requireValue(result.rowCount, "Session expired or revoked.", 401);
    // Transactions serialize revocation with sync writes.
    const session = await client.query(
        "SELECT 1 FROM auth_sessions WHERE user_id=$1 AND id=$2 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [auth.userId, auth.sessionId],
    );
    requireValue(session.rowCount, "Session expired or revoked.", 401);
    return result.rows[0]! as {
        id: string;
        email: string;
        password_hash: string;
        revision: string;
        library_revision: string | null;
    };
}
async function issueSession(
    client: Connection,
    config: ServerConfig,
    userId: string,
    deviceId: string,
    deviceName: string,
) {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(
        Date.now() + config.sessionDays * 86400_000,
    ).toISOString();
    await client.query(
        "INSERT INTO devices(user_id,id,name) VALUES ($1,$2,$3) ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [userId, deviceId, deviceName],
    );
    await client.query(
        "DELETE FROM auth_sessions WHERE user_id=$1 AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [userId],
    );
    await client.query(
        "INSERT INTO auth_sessions(id,user_id,device_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)",
        [randomUUID(), userId, deviceId, tokenHash(token), expiresAt],
    );
    return { token, tokenType: "Bearer", expiresAt, userId, deviceId };
}
export async function registerAuthRoutes(
    app: FastifyInstance,
    database: Database,
    config: ServerConfig,
): Promise<void> {
    const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
    const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };
    app.post(
        "/v1/auth/register",
        { config: authLimit },
        async (request, reply) => {
            requireValue(
                config.registrationEnabled,
                "Account registration is disabled.",
                403,
            );
            const body = credentialsSchema.parse(request.body);
            const passwordHash = await hashPassword(body.password);
            const result = await transaction(database, async (client) => {
                const userId = randomUUID();
                await client.query(
                    "INSERT INTO users(id,email,password_hash) VALUES ($1,$2,$3)",
                    [userId, body.email.toLowerCase(), passwordHash],
                );
                return issueSession(
                    client,
                    config,
                    userId,
                    body.deviceId,
                    body.deviceName,
                );
            });
            return reply.code(201).send(result);
        },
    );
    app.post("/v1/auth/login", { config: authLimit }, async (request) => {
        const body = credentialsSchema.parse(request.body);
        const result = await database.query(
            "SELECT id,password_hash FROM users WHERE email=$1",
            [body.email.toLowerCase()],
        );
        const user = result.rows[0]!;
        const valid = await verifyPassword(
            body.password,
            user?.password_hash ?? dummyHash,
        );
        requireValue(user && valid, "Invalid email or password.", 401);
        return transaction(database, async (client) => {
            const locked = await client.query(
                "SELECT password_hash FROM users WHERE id=$1",
                [user.id],
            );
            requireValue(
                locked.rows[0]!?.password_hash === user.password_hash,
                "Account changed. Please log in again.",
                401,
            );
            return issueSession(
                client,
                config,
                user.id,
                body.deviceId,
                body.deviceName,
            );
        });
    });
    await app.register(async (secured) => {
        secured.addHook("preHandler", async (request) =>
            authenticate(request, database),
        );
        secured.get("/v1/me", async (request) => {
            const auth = request.userAuth!;
            const result = await database.query(
                "SELECT id,email,created_at FROM users WHERE id=$1",
                [auth.userId],
            );
            requireValue(result.rowCount, "Account not found.", 401);
            return { user: result.rows[0]!, deviceId: auth.deviceId };
        });
        secured.post("/v1/auth/logout", async (request, reply) => {
            await transaction(database, async (client) => {
                await lockUser(client, request.userAuth!);
                await client.query("DELETE FROM auth_sessions WHERE id=$1", [
                    request.userAuth!.sessionId,
                ]);
            });
            return reply.code(204).send();
        });
        secured.post(
            "/v1/auth/password",
            { config: authLimit },
            async (request, reply) => {
                const body = passwordSchema.parse(request.body);
                const newHash = await hashPassword(body.newPassword);
                await transaction(database, async (client) => {
                    const user = await lockUser(client, request.userAuth!);
                    requireValue(
                        await verifyPassword(
                            body.currentPassword,
                            user.password_hash,
                        ),
                        "Invalid password.",
                        401,
                    );
                    await client.query(
                        "UPDATE users SET password_hash=$2 WHERE id=$1",
                        [user.id, newHash],
                    );
                    await client.query(
                        "DELETE FROM auth_sessions WHERE user_id=$1",
                        [user.id],
                    );
                });
                return reply.code(204).send();
            },
        );
        secured.get("/v1/devices", async (request) => {
            const result = await database.query(
                "SELECT id,name,created_at,last_seen_at FROM devices WHERE user_id=$1 ORDER BY created_at,id",
                [request.userAuth!.userId],
            );
            return { devices: result.rows };
        });
        secured.delete<{ Params: { id: string } }>(
            "/v1/devices/:id",
            async (request, reply) => {
                const id = idSchema.parse(request.params.id);
                await transaction(database, async (client) => {
                    const user = await lockUser(client, request.userAuth!);
                    const result = await client.query(
                        "DELETE FROM devices WHERE user_id=$1 AND id=$2",
                        [user.id, id],
                    );
                    requireValue(result.rowCount, "Device not found.", 404);
                });
                return reply.code(204).send();
            },
        );
        secured.delete(
            "/v1/me",
            { config: authLimit },
            async (request, reply) => {
                const body = deleteAccountSchema.parse(request.body);
                await transaction(database, async (client) => {
                    const user = await lockUser(client, request.userAuth!);
                    requireValue(
                        await verifyPassword(body.password, user.password_hash),
                        "Invalid password.",
                        401,
                    );
                    await client.query("DELETE FROM users WHERE id=$1", [
                        user.id,
                    ]);
                });
                return reply.code(204).send();
            },
        );
    });
}
