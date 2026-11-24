import { invoke, isTauri } from "@tauri-apps/api/core";
import * as publicEnvironment from "$env/static/public";
import type { CloudResponse, CloudSession } from "./types";

export class CloudError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}
export function serverUrl(): string | null {
    const preview =
        import.meta.env.DEV && typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("api-preview")
            : null;
    if (
        preview &&
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(preview).hostname)
    )
        throw new Error("API preview must use localhost.");
    const configured = Reflect.get(publicEnvironment, "PUBLIC_API_BASE_URL");
    const value =
        preview ?? (typeof configured === "string" ? configured.trim() : null);
    if (!value) return null;
    const url = new URL(value);
    if (
        url.protocol !== "https:" &&
        !(
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )
    )
        throw new Error(
            "Use an HTTPS API address, or localhost for development.",
        );
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
    )
        throw new Error(
            "PUBLIC_API_BASE_URL must be a base address without a path or credentials.",
        );
    return url.origin;
}
let previewSession: (CloudSession & { token: string }) | null = null;
let previewDeviceId: string | null = null;
export async function getCloudSession(): Promise<CloudSession | null> {
    const base = serverUrl();
    if (!base) return null;
    if (isTauri()) return invoke("cloud_get_session", { serverUrl: base });
    return previewSession
        ? {
              userId: previewSession.userId,
              deviceId: previewSession.deviceId,
              email: previewSession.email,
              expiresAt: previewSession.expiresAt,
          }
        : null;
}
function readResponse(value: CloudResponse): unknown {
    if (value.status < 200 || value.status >= 300) {
        const body = value.body as {
            error?: string;
            issues?: { path?: unknown[]; message?: string }[];
        } | null;
        const details = Array.isArray(body?.issues)
            ? body.issues
                  .slice(0, 5)
                  .map(
                      (issue) =>
                          `${issue.path?.join(".") ?? "Request"}: ${issue.message ?? "Invalid value"}`,
                  )
                  .join("\n")
            : "";
        throw new CloudError(
            value.status,
            (body?.error ?? `The server returned HTTP ${value.status}.`) +
                (details ? `\n${details}` : "") +
                (value.status === 401 ? " Sign out and sign in again." : ""),
        );
    }
    return value.body;
}
async function browserRequest(
    path: string,
    method: string,
    body: unknown,
    authenticated: boolean,
): Promise<CloudResponse> {
    const response = await fetch(`${serverUrl()}${path}`, {
        method,
        headers: {
            ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            ...(authenticated && previewSession
                ? { Authorization: `Bearer ${previewSession.token}` }
                : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
    });
    return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
    };
}
export async function cloudRequest<T>(
    path: string,
    method = "GET",
    body?: unknown,
    retry = true,
): Promise<T> {
    const base = serverUrl();
    if (!base)
        throw new Error(
            "Set PUBLIC_API_BASE_URL in the project .env and restart the app.",
        );
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = isTauri()
                ? await invoke<CloudResponse>("cloud_request", {
                      serverUrl: base,
                      path,
                      method,
                      body: body ?? null,
                  })
                : await browserRequest(path, method, body, true);
            if (
                retry &&
                [429, 502, 503, 504].includes(response.status) &&
                attempt < 2
            ) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 750 * 2 ** attempt),
                );
                continue;
            }
            return readResponse(response) as T;
        } catch (error) {
            if (error instanceof CloudError || !retry || attempt === 2)
                throw error;
            await new Promise((resolve) =>
                setTimeout(resolve, 750 * 2 ** attempt),
            );
        }
    }
    throw new Error("Unable to reach the study server.");
}
export async function signIn(
    email: string,
    password: string,
    register = false,
): Promise<CloudSession> {
    const base = serverUrl();
    if (!base)
        throw new Error(
            "Set PUBLIC_API_BASE_URL in the project .env and restart the app.",
        );
    if (isTauri())
        return invoke("cloud_sign_in", {
            serverUrl: base,
            email,
            password,
            register,
        });
    previewDeviceId ??=
        localStorage.getItem("obstudy-preview-device") ?? crypto.randomUUID();
    localStorage.setItem("obstudy-preview-device", previewDeviceId);
    const response = await browserRequest(
        `/v1/auth/${register ? "register" : "login"}`,
        "POST",
        {
            email,
            password,
            deviceId: previewDeviceId,
            deviceName: "Obstudy browser preview",
        },
        false,
    );
    const result = readResponse(response) as CloudSession & { token: string };
    previewSession = { ...result, email };
    return {
        userId: result.userId,
        deviceId: result.deviceId,
        email,
        expiresAt: result.expiresAt,
    };
}
export async function signOut(): Promise<void> {
    const base = serverUrl();
    if (isTauri() && base) await invoke("cloud_sign_out", { serverUrl: base });
    else {
        try {
            await cloudRequest("/v1/auth/logout", "POST", undefined, false);
        } catch {
            // Sign out locally even if the server cannot be reached.
        } finally {
            previewSession = null;
        }
    }
}
