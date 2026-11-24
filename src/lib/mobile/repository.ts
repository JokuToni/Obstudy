import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MobileRepository, MobileState, StoredMobileState } from "./types";

export class NativeMobileRepository implements MobileRepository {
    constructor(private scope = "") {}
    load(): Promise<StoredMobileState> {
        return invoke("mobile_load_state", { scope: this.scope });
    }
    save(expectedRevision: number, state: MobileState): Promise<number> {
        return invoke("mobile_save_state", {
            expectedRevision,
            state,
            scope: this.scope,
        });
    }
}

/** Durable browser preview adapter; the native iOS app uses SQLite. */
export class BrowserMobileRepository implements MobileRepository {
    constructor(private scope = "current") {}
    private async open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("obstudy-mobile-preview", 1);
            request.onupgradeneeded = () =>
                request.result.createObjectStore("state");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async load(): Promise<StoredMobileState> {
        const database = await this.open();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = database.transaction("state", "readonly");
                const request = transaction
                    .objectStore("state")
                    .get(this.scope);
                transaction.oncomplete = () =>
                    resolve(request.result ?? { revision: 0, state: null });
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () =>
                    reject(
                        transaction.error ??
                            new Error("Unable to read study data."),
                    );
            });
        } finally {
            database.close();
        }
    }
    async save(expectedRevision: number, state: MobileState): Promise<number> {
        const database = await this.open();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = database.transaction("state", "readwrite");
                const store = transaction.objectStore("state");
                const request = store.get(this.scope);
                let conflict = false;
                request.onsuccess = () => {
                    if ((request.result?.revision ?? 0) !== expectedRevision) {
                        conflict = true;
                        transaction.abort();
                        return;
                    }
                    store.put(
                        {
                            revision: expectedRevision + 1,
                            state: structuredClone(state),
                        },
                        this.scope,
                    );
                };
                transaction.oncomplete = () => resolve(expectedRevision + 1);
                transaction.onabort = () =>
                    reject(
                        new Error(
                            conflict
                                ? "Study data changed elsewhere. Reload before continuing."
                                : "Unable to save study data.",
                        ),
                    );
                transaction.onerror = () => reject(transaction.error);
            });
        } finally {
            database.close();
        }
    }
}
export function mobileRepository(scope = ""): MobileRepository {
    return isTauri()
        ? new NativeMobileRepository(scope)
        : new BrowserMobileRepository(scope || "current");
}
