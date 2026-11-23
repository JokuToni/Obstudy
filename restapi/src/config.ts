export interface ServerConfig {
    host: string;
    port: number;
    logLevel:
        "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
    databasePath: string;
    registrationEnabled: boolean;
    sessionDays: number;
    corsOrigins: string[];
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const host = env.HOST ?? "127.0.0.1";
    const portText = env.PORT ?? "3000";
    const port = Number(portText);
    const logLevel = env.LOG_LEVEL ?? "info";
    if (!host.trim()) throw new Error("HOST must not be empty.");
    if (
        !/^\d+$/.test(portText) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    )
        throw new Error("PORT must be an integer between 1 and 65535.");
    if (
        ![
            "fatal",
            "error",
            "warn",
            "info",
            "debug",
            "trace",
            "silent",
        ].includes(logLevel)
    )
        throw new Error("LOG_LEVEL is invalid.");
    const databasePath = env.DATABASE_PATH ?? "./data/obstudy-api.db";
    if (!databasePath.trim() || databasePath.includes("\0"))
        throw new Error("DATABASE_PATH must be a valid SQLite file path.");
    const registration = env.REGISTRATION_ENABLED ?? "false";
    if (!["true", "false"].includes(registration))
        throw new Error("REGISTRATION_ENABLED must be true or false.");
    const sessionText = env.SESSION_DAYS ?? "30";
    const sessionDays = Number(sessionText);
    if (!/^\d+$/.test(sessionText) || sessionDays < 1 || sessionDays > 90)
        throw new Error("SESSION_DAYS must be between 1 and 90.");
    const corsOrigins = (env.CORS_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
    for (const origin of corsOrigins) {
        if (origin !== "tauri://localhost") {
            const url = new URL(origin);
            if (
                !["http:", "https:"].includes(url.protocol) ||
                url.origin !== origin
            )
                throw new Error("CORS_ORIGINS must contain exact origins.");
        }
    }
    return {
        host,
        port,
        logLevel: logLevel as ServerConfig["logLevel"],
        databasePath,
        registrationEnabled: registration === "true",
        sessionDays,
        corsOrigins,
    };
}
