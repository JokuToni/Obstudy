import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
const scryptOptions = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
function deriveKey(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) =>
        scrypt(password, salt, 64, scryptOptions, (error, key) => {
            if (error) reject(error);
            else resolve(key);
        }),
    );
}
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("hex");
    const key = (await deriveKey(password, salt)) as Buffer;
    return `scrypt-65536:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(
    password: string,
    encoded: string,
): Promise<boolean> {
    const [algorithm, salt, key] = encoded.split(":");
    if (algorithm !== "scrypt-65536" || !salt || !key) return false;
    const actual = (await deriveKey(password, salt)) as Buffer;
    const expected = Buffer.from(key, "hex");
    return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
    );
}
export const tokenHash = (token: string): string =>
    createHash("sha256").update(token).digest("hex");
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object")
        return `{${Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(",")}}`;
    return JSON.stringify(value) ?? "null";
}
