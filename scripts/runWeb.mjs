import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
if (!["dev", "build"].includes(command))
    throw new Error("Choose dev or build.");
const vite = fileURLToPath(
    new URL("../node_modules/vite/bin/vite.js", import.meta.url),
);
const child = spawn(
    process.execPath,
    [vite, command, "--mode", "web", ...process.argv.slice(3)],
    {
        stdio: "inherit",
        env: { ...process.env, OBSTUDY_WEB: "1" },
    },
);
child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
});
child.on("exit", async (code) => {
    if (code !== 0) {
        process.exitCode = code ?? 1;
        return;
    }
    if (command === "build") await import("./buildWebApp.mjs");
});
