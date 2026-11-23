import { randomUUID } from "node:crypto";
import type { Database, Connection } from "./database.js";
import type { Catalog } from "./schemas.js";
import { validateCatalog } from "./schemas.js";
import { requireValue } from "./errors.js";
import { canonical } from "./security.js";

export interface AccountVersion {
    id: string;
    revision: string;
    library_revision: string | null;
}
export function catalogRevision(user: AccountVersion): string | null {
    return user.library_revision
        ? `${user.library_revision}:${user.revision}`
        : null;
}
export async function readCatalog(
    client: Connection,
    user: AccountVersion,
): Promise<Catalog | undefined> {
    if (!user.library_revision) return undefined;
    const result = await client.query(
        "SELECT document FROM library_versions WHERE user_id=$1 AND id=$2",
        [user.id, user.library_revision],
    );
    const catalog = result.rows[0]!.document as Catalog;
    catalog.revision = catalogRevision(user)!;
    const stored = await client.query(
        "SELECT question_id,current_card FROM cards WHERE user_id=$1",
        [user.id],
    );
    const cards = new Map(
        stored.rows.map((row) => [row.question_id, row.current_card]),
    );
    for (const set of catalog.sets)
        for (const card of set.cards)
            card.fsrsData = cards.get(card.questionId) ?? card.fsrsData;
    return catalog;
}
export async function uploadCatalog(
    client: Connection,
    user: AccountVersion,
    baseRevision: string | null,
    catalog: Catalog,
): Promise<Catalog> {
    requireValue(
        baseRevision === catalogRevision(user),
        "Library changed. Download the current library before uploading.",
        409,
    );
    validateCatalog(catalog);
    const version = randomUUID();
    // A question ID identifies immutable study content. Edit content using a new ID.
    const historical = await client.query(
        "SELECT document FROM library_versions WHERE user_id=$1",
        [user.id],
    );
    const identities = new Map<string, string>();
    for (const row of historical.rows)
        for (const set of (row.document as Catalog).sets)
            for (const question of set.questions) {
                const { lastAnsweredAt, averageScore, topicIds, ...identity } =
                    question;
                identities.set(question.id, canonical(identity));
            }
    for (const set of catalog.sets)
        for (const question of set.questions) {
            const { lastAnsweredAt, averageScore, topicIds, ...identity } =
                question;
            requireValue(
                !identities.has(question.id) ||
                    identities.get(question.id) === canonical(identity),
                "Question content changed under an existing ID. Assign a new question ID.",
                409,
            );
        }
    for (const set of catalog.sets)
        for (const card of set.cards) {
            await client.query(
                "INSERT INTO cards(user_id,question_id,base_card,current_card) VALUES ($1,$2,$3,$3) ON CONFLICT(user_id,question_id) DO NOTHING",
                [user.id, card.questionId, JSON.stringify(card.fsrsData)],
            );
        }
    const document = { ...catalog, revision: version, isSample: false };
    await client.query(
        "INSERT INTO library_versions(user_id,id,document) VALUES ($1,$2,$3)",
        [user.id, version, JSON.stringify(document)],
    );
    const updated = await client.query(
        "UPDATE users SET revision=revision+1,library_revision=$2 WHERE id=$1 RETURNING revision,library_revision",
        [user.id, version],
    );
    Object.assign(user, updated.rows[0]!);
    return (await readCatalog(client, user))!;
}
export async function versionCatalog(
    client: Connection,
    userId: string,
    revision: string,
): Promise<Catalog> {
    const parts = revision.split(":");
    requireValue(
        parts.length === 2 && /^(0|[1-9]\d*)$/.test(parts[1]!),
        "Invalid catalog revision.",
        409,
    );
    const result = await client.query(
        "SELECT document FROM library_versions WHERE user_id=$1 AND id=$2",
        [userId, parts[0]!],
    );
    requireValue(
        result.rowCount,
        "Unknown catalog revision. Download the library first.",
        409,
    );
    return result.rows[0]!.document;
}
