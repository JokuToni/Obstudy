import { invoke } from "@tauri-apps/api/core";
import { getNotesFolderPath } from "$lib/services/settings";

export interface DatabaseInfo {
    databasePath: string;
    schemaVersion: number;
}

/**
 * Create/open obstudy.db in an existing notes folder and apply pending migrations.
 * Repeated calls preserve existing data. Storage errors are propagated to the caller.
 * Without a folder argument, use the path persisted in Tauri Store.
 */
export async function initializeDatabase(
    folderPath?: string,
): Promise<DatabaseInfo> {
    const notesFolderPath = folderPath ?? (await getNotesFolderPath());
    if (!notesFolderPath || notesFolderPath.trim().length === 0) {
        throw new Error(
            "Select a notes folder before initializing the database.",
        );
    }

    return invoke<DatabaseInfo>("initialize_database", {
        folderPath: notesFolderPath,
    });
}
