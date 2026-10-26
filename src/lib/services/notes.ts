import { invoke } from "@tauri-apps/api/core";
import { getNotesFolderPath } from "$lib/services/settings";
import type {
    NoteIssueAction,
    NoteSyncResult,
    TopicParseResult,
} from "$lib/types/notes";

/** hankiAiheet: parse the documented Markdown topic hierarchy locally. */
export function extractTopics(text: string): Promise<TopicParseResult> {
    return invoke("extract_note_topics", { text });
}

export async function setNoteStudying(
    noteId: string,
    isStudying: boolean,
): Promise<void> {
    const folderPath = await getNotesFolderPath();
    if (!folderPath) throw new Error("Select a notes folder first.");
    return invoke("set_note_studying", { folderPath, noteId, isStudying });
}

/** haeObsidianMuistiinpanot: synchronize tagged notes and load their saved data. */
export async function fetchObsidianNotes(
    folderPath?: string,
): Promise<NoteSyncResult> {
    const path = folderPath ?? (await getNotesFolderPath());
    if (!path)
        throw new Error("Select a notes folder before synchronizing notes.");
    return invoke("fetch_obsidian_notes", { folderPath: path });
}

export async function resolveNoteIssue(
    issueId: string,
    action: NoteIssueAction,
    broadTopicId?: string,
): Promise<NoteSyncResult> {
    const folderPath = await getNotesFolderPath();
    if (!folderPath) throw new Error("Select a notes folder first.");
    return invoke("resolve_note_issue", {
        folderPath,
        issueId,
        action,
        broadTopicId,
    });
}
