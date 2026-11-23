import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServerConfig } from "./config.js";

// JSON columns are decoded at the repository boundary; integers stay lossless strings.
export interface QueryResult {
    rows: Record<string, any>[];
    rowCount: number;
}
export interface Connection {
    query(sql: string, values?: SQLInputValue[]): Promise<QueryResult>;
    exec(sql: string): Promise<void>;
}
export class Database {
    private sqlite: DatabaseSync;
    private pending: Promise<unknown> = Promise.resolve();
    private closing = false;
    constructor(path: string) {
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.sqlite = new DatabaseSync(path, { timeout: 5000 });
        if (path !== ":memory:") chmodSync(path, 0o600);
        this.sqlite.exec(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        );
    }
    private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
        if (this.closing)
            return Promise.reject(new Error("Database is closed."));
        const next = this.pending.catch(() => {}).then(operation);
        this.pending = next;
        return next;
    }
    private queryNow(sql: string, values: SQLInputValue[] = []): QueryResult {
        const statement = this.sqlite.prepare(sql);
        statement.setReadBigInts(true);
        statement.setAllowBareNamedParameters(false);
        const bindings = Object.fromEntries(
            values.map((value, index) => [`$${index + 1}`, value]),
        );
        if (!statement.columns().length) {
            const result = values.length
                ? statement.run(bindings)
                : statement.run();
            return { rows: [], rowCount: Number(result.changes) };
        }
        const rows = values.length ? statement.all(bindings) : statement.all();
        return {
            rows: rows.map((row) =>
                Object.fromEntries(
                    Object.entries(row).map(([key, value]) => [
                        key,
                        typeof value === "bigint"
                            ? value.toString()
                            : [
                                    "document",
                                    "question",
                                    "base_card",
                                    "current_card",
                                ].includes(key) && typeof value === "string"
                              ? JSON.parse(value)
                              : value,
                    ]),
                ),
            ),
            rowCount: rows.length,
        };
    }
    query(sql: string, values?: SQLInputValue[]): Promise<QueryResult> {
        return this.enqueue(() => this.queryNow(sql, values));
    }
    transaction<T>(operation: (client: Connection) => Promise<T>): Promise<T> {
        return this.enqueue(async () => {
            this.sqlite.exec("BEGIN IMMEDIATE");
            const client: Connection = {
                query: async (sql, values) => this.queryNow(sql, values),
                exec: async (sql) => {
                    this.sqlite.exec(sql);
                },
            };
            try {
                const result = await operation(client);
                this.sqlite.exec("COMMIT");
                return result;
            } catch (error) {
                this.sqlite.exec("ROLLBACK");
                throw error;
            }
        });
    }
    async close(): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        await this.pending.catch(() => {});
        this.sqlite.close();
    }
}
export const createDatabase = (config: ServerConfig): Database =>
    new Database(config.databasePath);
export function transaction<T>(
    database: Database,
    operation: (client: Connection) => Promise<T>,
): Promise<T> {
    return database.transaction(operation);
}
/** The same immediate transaction applies SQL and verifies migration checksums. */
export async function migrate(database: Database): Promise<void> {
    await transaction(database, async (client) => {
        await client.exec(
            "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,digest TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))) STRICT",
        );
        const directory = new URL("../migrations/", import.meta.url);
        const names = (await readdir(directory))
            .filter((name) => /^\d+_.+\.sql$/.test(name))
            .sort();
        for (const name of names) {
            const sql = await readFile(new URL(name, directory), "utf8");
            const digest = createHash("sha256").update(sql).digest("hex");
            const existing = await client.query(
                "SELECT digest FROM schema_migrations WHERE name=$1",
                [name],
            );
            if (existing.rowCount) {
                if (existing.rows[0]!.digest !== digest)
                    throw new Error(`Applied migration changed: ${name}`);
                continue;
            }
            await client.exec(sql);
            await client.query(
                "INSERT INTO schema_migrations(name,digest) VALUES ($1,$2)",
                [name, digest],
            );
        }
    });
}
