import type { FastifyInstance } from "fastify";
import type { Database, Connection } from "../database.js";
import { authenticate, lockUser } from "../auth.js";
import { transaction } from "../database.js";
import { requireValue } from "../errors.js";
import { readCatalog, uploadCatalog } from "../library.js";
import { pageSchema, syncSchema, uploadSchema } from "../schemas.js";
import { exchange } from "../sync.js";

export async function registerDataRoutes(
    app: FastifyInstance,
    database: Database,
): Promise<void> {
    await app.register(async (secured) => {
        secured.addHook("preHandler", async (request) =>
            authenticate(request, database),
        );
        secured.get("/v1/library", async (request) =>
            transaction(database, async (client) => {
                const user = await lockUser(client, request.userAuth!);
                const catalog = await readCatalog(client, user);
                requireValue(catalog, "No library has been uploaded.", 404);
                return { catalog };
            }),
        );
        secured.put(
            "/v1/library",
            { bodyLimit: 10 * 1024 * 1024 },
            async (request) => {
                const body = uploadSchema.parse(request.body);
                return transaction(database, async (client) => {
                    const user = await lockUser(client, request.userAuth!);
                    return {
                        catalog: await uploadCatalog(
                            client,
                            user,
                            body.baseRevision,
                            body.catalog,
                        ),
                    };
                });
            },
        );
        secured.post(
            "/v1/sync",
            { bodyLimit: 10 * 1024 * 1024 },
            async (request) => {
                const body = syncSchema.parse(request.body);
                return transaction(database, async (client) => {
                    const user = await lockUser(client, request.userAuth!);
                    return exchange(client, request.userAuth!, user, body);
                });
            },
        );
        secured.get("/v1/answers", async (request) => {
            const page = pageSchema.parse(request.query);
            const limit = page.limit ?? 100;
            const result = await database.query(
                "SELECT sequence,note_id,document,question FROM answers WHERE user_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3",
                [request.userAuth!.userId, page.after ?? "0", limit + 1],
            );
            const rows = result.rows.slice(0, limit);
            return {
                answers: rows.map((row) => ({
                    sequence: row.sequence,
                    noteId: row.note_id,
                    answer: row.document,
                    question: row.question,
                })),
                cursor: rows.at(-1)?.sequence ?? page.after ?? "0",
                hasMore: result.rows.length > limit,
            };
        });
        secured.get("/v1/reviews", async (request) => {
            const page = pageSchema.parse(request.query);
            const limit = page.limit ?? 100;
            const result = await database.query(
                "SELECT a.sequence,r.answer_id,r.document FROM reviews r JOIN answers a ON a.user_id=r.user_id AND a.id=r.answer_id WHERE r.user_id=$1 AND a.sequence>$2 ORDER BY a.sequence LIMIT $3",
                [request.userAuth!.userId, page.after ?? "0", limit + 1],
            );
            const rows = result.rows.slice(0, limit);
            return {
                reviews: rows.map((row) => ({
                    sequence: row.sequence,
                    answerId: row.answer_id,
                    review: row.document,
                })),
                cursor: rows.at(-1)?.sequence ?? page.after ?? "0",
                hasMore: result.rows.length > limit,
            };
        });
    });
}
