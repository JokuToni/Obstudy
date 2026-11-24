import type { Answer, Question, QuestionFsrs, Topic } from "../types";
import type { ExerciseSession } from "../types/exercises";

/** Portable catalog: IDs are stable across devices; no vault or device paths. */
export interface MobileStudySet {
    id: string;
    title: string;
    isStudying?: boolean;
    topics: Topic[];
    questions: Question[];
    cards: QuestionFsrs[];
}
export interface MobileCatalog {
    schemaVersion: 1;
    revision: string;
    isSample?: boolean;
    sets: MobileStudySet[];
}
interface EventBase {
    id: string;
    deviceId: string;
    occurredAt: string;
    catalogRevision: string;
}
export interface MobileReview {
    questionId: string;
    beforeCard: QuestionFsrs["fsrsData"];
    afterCard: QuestionFsrs["fsrsData"];
    reviewedAt: string;
    rating: 1 | 2 | 3 | 4;
    reviewLog: Record<string, unknown>;
}
export type MobileEvent = EventBase &
    (
        | {
              kind: "answer.graded";
              payload: { noteId: string; answer: Answer; question: Question };
          }
        | {
              kind: "review.applied";
              payload: {
                  answerId: string;
                  exerciseId: string;
                  review: MobileReview;
              };
          }
        | {
              kind: "session.closed";
              payload: {
                  exerciseId: string;
                  noteId: string;
                  answerIds: string[];
              };
          }
    );
export interface MobileSession extends ExerciseSession {
    catalogRevision: string;
}
export interface MobileState {
    schemaVersion: 1;
    deviceId: string;
    catalog: MobileCatalog | null;
    cards: QuestionFsrs[];
    answers: Answer[];
    reviewedAnswerIds: string[];
    sessions: MobileSession[];
    outbox: MobileEvent[];
    syncCursor: string | null;
}
export interface StoredMobileState {
    revision: number;
    state: MobileState | null;
}
export interface MobileRepository {
    load(): Promise<StoredMobileState>;
    save(expectedRevision: number, state: MobileState): Promise<number>;
}
/** No URL/authentication assumptions: a future server implements this port. */
export interface MobileSyncTransport {
    exchange(request: {
        schemaVersion: 1;
        deviceId: string;
        cursor: string | null;
        events: MobileEvent[];
    }): Promise<{
        cursor: string;
        acknowledgedIds: string[];
        catalog?: MobileCatalog;
        events?: { sequence: string; event: MobileEvent }[];
        hasMore?: boolean;
    }>;
}
