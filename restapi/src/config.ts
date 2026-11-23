export interface ServerConfig {
    host: string;
    port: number;
    logLevel:
        "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
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
    return { host, port, logLevel: logLevel as ServerConfig["logLevel"] };
}
