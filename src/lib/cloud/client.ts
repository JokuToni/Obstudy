import { invoke, isTauri } from "@tauri-apps/api/core";
import * as publicEnvironment from "$env/static/public";
import { isWebBuild } from "$lib/mobile/runtime";
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
    if (isWebBuild && typeof window !== "undefined")
        return window.location.origin;
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
let webAccount: CloudSession | null = null;
let previewSession: (CloudSession & { token: string }) | null = null;
let previewDeviceId: string | null = null;
export async function getCloudSession(): Promise<CloudSession | null> {
    const base = serverUrl();
    if (!base) return null;
    if (isTauri()) return invoke("cloud_get_session", { serverUrl: base });
    if (isWebBuild) return restoreWebSession();
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
        credentials: isWebBuild ? "same-origin" : "omit",
        cache: "no-store",
        headers: {
            ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            ...(isWebBuild
                ? {
                      "X-Obstudy-Web": "1",
                      ...(webAccount
                          ? { "X-Obstudy-Account": webAccount.userId }
                          : {}),
                  }
                : {}),
            ...(!isWebBuild && authenticated && previewSession
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
        `/v1/${isWebBuild ? "web/" : ""}auth/${register ? "register" : "login"}`,
        "POST",
        {
            email,
            password,
            deviceId: previewDeviceId,
            deviceName: isWebBuild
                ? "Obstudy web app"
                : "Obstudy browser preview",
        },
        false,
    );
    const result = readResponse(response) as CloudSession & { token: string };
    if (isWebBuild) {
        const session = {
            userId: result.userId,
            deviceId: result.deviceId,
            email: result.email,
            expiresAt: result.expiresAt,
        };
        rememberWebSession(session);
        return session;
    }
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
    else if (isWebBuild) {
        // HttpOnly cookies can only be cleared by the server. Keep the account visible on failure.
        try {
            await cloudRequest("/v1/web/auth/logout", "POST", undefined, false);
        } catch (error) {
            if (error instanceof CloudError) throw error;
            throw new Error(
                "Connect to the internet to sign out. Your account is still signed in.",
            );
        }
        localStorage.removeItem(webSessionKey);
        webAccount = null;
        previewSession = null;
    } else {
        try {
            await cloudRequest("/v1/auth/logout", "POST", undefined, false);
        } catch {
            // Sign out locally even if the server cannot be reached.
        } finally {
            previewSession = null;
        }
    }
}

const webSessionKey = "obstudy-web-account";
function rememberWebSession(session: CloudSession): void {
    webAccount = session;
    // Non-secret account metadata lets the correct offline cache reopen; no credential is stored here.
    localStorage.setItem(webSessionKey, JSON.stringify(session));
}
async function restoreWebSession(): Promise<CloudSession | null> {
    try {
        const response = await browserRequest(
            "/v1/web/auth/session",
            "GET",
            undefined,
            true,
        );
        if (response.status === 401) {
            localStorage.removeItem(webSessionKey);
            webAccount = null;
            return null;
        }
        const session = readResponse(response) as CloudSession;
        rememberWebSession(session);
        return session;
    } catch (error) {
        if (error instanceof CloudError && error.status < 500) throw error;
        const cached = localStorage.getItem(webSessionKey);
        if (cached) {
            try {
                const session = JSON.parse(cached) as CloudSession;
                if (
                    typeof session.userId === "string" &&
                    typeof session.deviceId === "string" &&
                    typeof session.email === "string" &&
                    Date.parse(session.expiresAt) > Date.now()
                )
                    return (webAccount = session);
            } catch {
                /* Ignore invalid metadata; saved answers remain in IndexedDB. */
            }
        }
        return null;
    }
}
