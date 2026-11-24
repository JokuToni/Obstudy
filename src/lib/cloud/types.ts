import type { MobileCatalog, MobileEvent } from "../mobile/types";
import type { Answer, Question } from "../types";

export interface CloudSession {
    userId: string;
    deviceId: string;
    email: string;
    expiresAt: string;
}
export interface CloudResponse {
    status: number;
    body: unknown;
}
export interface CloudHistoryRecord {
    noteId: string;
    answer: Answer;
    question: Question;
}
export interface CloudExchange {
    cursor: string;
    acknowledgedIds: string[];
    catalog?: MobileCatalog;
    events?: { sequence: string; event: MobileEvent }[];
    hasMore?: boolean;
}
