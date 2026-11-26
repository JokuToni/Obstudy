import { writable, get } from "svelte/store";
import { getCloudSession } from "./client";
import { getNotesFolderPath } from "../services/settings";
import {
    synchronizeDesktop,
    unlinkDesktopFolder,
    type DesktopFolderLink,
} from "./desktop";
import type { CloudSession } from "./types";

export const desktopAccount = writable<{
    session: CloudSession | null;
    syncing: boolean;
    lastSync: string | null;
    error: string | null;
}>({ session: null, syncing: false, lastSync: null, error: null });
let requested = false;
let running = false;
let unlinking = false;
let generation = 0;
export async function syncDesktopAccount(): Promise<void> {
    const state = get(desktopAccount);
    if (!state.session || unlinking) return;
    if (running) {
        requested = true;
        return;
    }
    running = true;
    const currentGeneration = generation;
    desktopAccount.update((value) => ({ ...value, syncing: true }));
    try {
        const folder = await getNotesFolderPath();
        if (!folder)
            throw new Error("Choose your notes folder before syncing.");
        await synchronizeDesktop(folder, state.session);
        if (generation !== currentGeneration) return;
        desktopAccount.update((value) => ({
            ...value,
            lastSync: new Date().toISOString(),
            error: null,
        }));
        window.dispatchEvent(new Event("obstudy-cloud-synced"));
    } catch (error) {
        if (generation !== currentGeneration) return;
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
        running = false;
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
    if (unlinking) return;
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

export async function unlinkDesktopAccount(
    folderPath: string,
    link: DesktopFolderLink,
): Promise<void> {
    if (unlinking) return;
    unlinking = true;
    let session = get(desktopAccount).session;
    requested = false;
    disconnectDesktopAccount();
    try {
        session ??= await getCloudSession();
        await unlinkDesktopFolder(folderPath, link, session);
    } finally {
        unlinking = false;
    }
}
