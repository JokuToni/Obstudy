import type { SyncedNote } from "./notes";

export type WorkspaceTab = "overview" | "settings" | "ai" | `note:${string}`;

export const workspaceTabs: { id: WorkspaceTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "settings", label: "Practice settings" },
    { id: "ai", label: "AI integrations" },
];

export function noteTitle(note: SyncedNote): string {
    return (
        note.file.path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ||
        note.file.path
    );
}

export function tabLabel(tab: WorkspaceTab, notes: SyncedNote[] = []): string {
    if (tab.startsWith("note:")) {
        const note = notes.find((item) => item.id === tab.slice(5));
        return note ? noteTitle(note) : "Note";
    }
    return workspaceTabs.find((item) => item.id === tab)?.label ?? tab;
}

export function shortTabLabel(label: string): string {
    const characters = Array.from(label);
    return characters.length > 22
        ? `${characters.slice(0, 19).join("")}...`
        : label;
}
