import type { Answer, Exercise, Note, QuestionFsrs } from ".";

export interface ParsedBroadTopic {
    title: string;
}
export interface ParsedSubtopic {
    title: string;
    text: string;
    broadTopicIndex: number | null;
}
export interface TopicParseResult {
    broadTopics: ParsedBroadTopic[];
    subtopics: ParsedSubtopic[];
    coverage: number;
    warnings: string[];
}
export interface NoteSyncIssue {
    id: string;
    noteId: string;
    kind: "topicChanged" | "topicRemoved" | "orphanedSubtopic";
    topicId: string;
    topicKind: "broad" | "subtopic";
    title: string;
}
export interface SyncedNote extends Note {
    isAvailable: boolean;
    parseError: string | null;
    parseWarnings: string[];
    syncIssues: NoteSyncIssue[];
    answers: Answer[];
    exercises: Exercise[];
    questionFsrs: QuestionFsrs[];
}
export interface NoteSyncResult {
    notes: SyncedNote[];
    warnings: { filePath: string; message: string }[];
}
export type NoteIssueAction =
    "keepQuestions" | "archiveQuestions" | "detachParent" | "assignParent";
