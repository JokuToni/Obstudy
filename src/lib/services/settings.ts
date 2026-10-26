import { LazyStore } from "@tauri-apps/plugin-store";

const settingsFileName = import.meta.env.DEV
    ? "settings.dev.json"
    : "settings.json";
const notesFolderPathKey = "notesFolderPath";
const settingsStore = new LazyStore(settingsFileName, { autoSave: false });

export async function getNotesFolderPath(): Promise<string | null> {
    const folderPath = await settingsStore.get<unknown>(notesFolderPathKey);

    if (folderPath === undefined || folderPath === null) {
        return null;
    }

    if (typeof folderPath !== "string" || folderPath.trim().length === 0) {
        throw new Error(
            "The saved notes folder path must be a non-empty string.",
        );
    }

    return folderPath;
}

export async function setNotesFolderPath(folderPath: string): Promise<void> {
    if (typeof folderPath !== "string" || folderPath.trim().length === 0) {
        throw new Error("The notes folder path must be a non-empty string.");
    }

    await settingsStore.set(notesFolderPathKey, folderPath);
    await settingsStore.save();
}

export async function clearNotesFolderPath(): Promise<void> {
    await settingsStore.delete(notesFolderPathKey);
    await settingsStore.save();
}
