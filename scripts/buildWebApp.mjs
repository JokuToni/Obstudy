import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve("build-web");
// The phone client has no drawing editor or desktop overview. Keep their assets out of the deployment.
for (const directory of ["excalidraw", "textures"])
    await rm(join(root, directory), { recursive: true, force: true });
async function files(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
        await Promise.all(
            entries.map(async (entry) => {
                const path = `${prefix}/${entry.name}`;
                return entry.isDirectory()
                    ? files(join(directory, entry.name), path)
                    : [path];
            }),
        )
    ).flat();
}
// Native-only assets are not needed for phone practice. Never put API responses in Cache Storage.
const assets = (await files(root))
    .filter(
        (path) =>
            !path.startsWith("/excalidraw/") &&
            !path.startsWith("/textures/") &&
            !path.endsWith(".map") &&
            path !== "/service-worker.js",
    )
    .sort();
const digest = createHash("sha256");
for (const path of assets)
    digest.update(path).update(await readFile(join(root, path)));
const version = digest.digest("hex").slice(0, 20);
const worker = `
const cacheName = "obstudy-web-${version}";
const assets = ${JSON.stringify(assets)};
const assetPaths = new Set(assets);
self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
    // Wait until old clients close, or the user explicitly updates from the home screen.
});
self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        for (const name of await caches.keys()) {
            if (name.startsWith("obstudy-web-") && name !== cacheName) await caches.delete(name);
        }
        await self.clients.claim();
    })());
});
self.addEventListener("message", (event) => {
    if (event.data?.type !== "ACTIVATE_UPDATE") return;
    event.waitUntil((async () => {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (clients.length === 1 && clients[0].id === event.source?.id) await self.skipWaiting();
        else event.source?.postMessage({ type: "UPDATE_BLOCKED" });
    })());
});
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== self.location.origin ||
        url.pathname.startsWith("/v1/") || url.pathname === "/health" || url.pathname === "/ready") return;
    const path = event.request.mode === "navigate" && url.pathname === "/" ? "/index.html" : url.pathname;
    if (!assetPaths.has(path)) return;
    event.respondWith((async () => {
        const cache = await caches.open(cacheName);
        return await cache.match(path) || fetch(event.request);
    })());
});
`;
await writeFile(join(root, "service-worker.js"), worker.trimStart());
console.log(
    `Web app ${version}: ${assets.length} public files prepared for offline use.`,
);
