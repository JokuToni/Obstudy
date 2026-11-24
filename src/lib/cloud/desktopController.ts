import { writable, get } from "svelte/store";
import { getCloudSession } from "./client";
import { getNotesFolderPath } from "../services/settings";
import { synchronizeDesktop } from "./desktop";
import type { CloudSession } from "./types";

export const desktopAccount = writable<{
    session: CloudSession | null;
    syncing: boolean;
    lastSync: string | null;
    error: string | null;
}>({ session: null, syncing: false, lastSync: null, error: null });
let requested = false;
let generation = 0;
export async function syncDesktopAccount(): Promise<void> {
    const state = get(desktopAccount);
    if (!state.session) return;
    if (state.syncing) {
        requested = true;
        return;
    }
    desktopAccount.update((value) => ({ ...value, syncing: true }));
    try {
        const folder = await getNotesFolderPath();
        if (!folder)
            throw new Error("Choose your notes folder before syncing.");
        await synchronizeDesktop(folder, state.session);
        desktopAccount.update((value) => ({
            ...value,
            lastSync: new Date().toISOString(),
            error: null,
        }));
        window.dispatchEvent(new Event("obstudy-cloud-synced"));
    } catch (error) {
        desktopAccount.update((value) => ({
            ...value,
            error:
                typeof error === "string"
                    ? error
                    : error instanceof Error
                      ? error.message
                      : "Sync failed. Your local progress is saved.",
        }));
    } finally {
        desktopAccount.update((value) => ({ ...value, syncing: false }));
        if (requested) {
            requested = false;
            void syncDesktopAccount();
        }
    }
}
export async function connectDesktopAccount(
    session: CloudSession,
): Promise<void> {
    generation++;
    desktopAccount.update((value) => ({ ...value, session, error: null }));
    void syncDesktopAccount();
}
export function disconnectDesktopAccount(): void {
    generation++;
    desktopAccount.set({
        session: null,
        syncing: false,
        lastSync: null,
        error: null,
    });
}
export function startDesktopSync(): () => void {
    let disposed = false;
    const currentGeneration = generation;
    void getCloudSession()
        .then((session) => {
            if (!disposed && generation === currentGeneration) {
                desktopAccount.update((value) => ({ ...value, session }));
                if (session) void syncDesktopAccount();
            }
        })
        .catch((error) => {
            if (!disposed)
                desktopAccount.update((value) => ({
                    ...value,
                    error:
                        typeof error === "string"
                            ? error
                            : error instanceof Error
                              ? error.message
                              : "Unable to restore your account.",
                }));
        });
    const trigger = () => void syncDesktopAccount();
    const timer = setInterval(trigger, 60000);
    for (const event of ["focus", "online", "obstudy-cloud-changed"])
        window.addEventListener(event, trigger);
    return () => {
        disposed = true;
        clearInterval(timer);
        for (const event of ["focus", "online", "obstudy-cloud-changed"])
            window.removeEventListener(event, trigger);
    };
}
