import { syncBatch } from "../cloud/batch";
import type { Answer, PracticeSettings, StudyMode } from "../types";
import type { SyncedNote } from "../types/notes";
import type { ExerciseDraftAnswer, ExerciseSession } from "../types/exercises";
import {
    selectExerciseQuestions,
    defaultPracticeSettings,
} from "../exercises/selection";
import { scheduleReview } from "../fsrs/scheduler";
import { automaticGrade } from "../grading/answers";
import { applyCatalog, validateCatalog } from "./catalog";
import type {
    MobileCatalog,
    MobileSession,
    MobileEvent,
    MobileRepository,
    MobileState,
    MobileStudySet,
    MobileSyncTransport,
} from "./types";

type EventPayload = MobileEvent extends infer Event
    ? Event extends MobileEvent
        ? Pick<Event, "kind" | "payload">
        : never
    : never;

export function mobileNote(
    state: MobileState,
    set: MobileStudySet,
): SyncedNote {
    const questionIds = new Set(set.questions.map((question) => question.id));
    return {
        id: set.id,
        isStudying: set.isStudying !== false,
        isAvailable: true,
        file: { path: `${set.title}.md`, text: "" },
        topics: set.topics,
        questions: set.questions,
        savedPracticeSettings: null,
        performances: [],
        exercises: [],
        answers: state.answers.filter((answer) =>
            questionIds.has(answer.questionId),
        ),
        questionFsrs: state.cards.filter((card) =>
            questionIds.has(card.questionId),
        ),
        fsrsReviewedAnswerIds: state.reviewedAnswerIds,
        parseError: null,
        parseWarnings: [],
        syncIssues: [],
    };
}

/** All local changes, history, schedules, and the sync outbox commit together. */
export class MobileStudyService {
    private current: MobileState | null = null;
    private revision = 0;
    private synchronizing = false;
    private pending: Promise<unknown> = Promise.resolve();
    constructor(
        private repository: MobileRepository,
        private now = () => new Date(),
        private id: () => string = () => crypto.randomUUID(),
        private deviceId: string | null = null,
    ) {}
    get state(): MobileState {
        if (!this.current) throw new Error("Load study data first.");
        return structuredClone(this.current);
    }
    async load(): Promise<MobileState> {
        await this.pending.catch(() => {});
        const stored = await this.repository.load();
        if (
            stored.state &&
            (stored.state.schemaVersion !== 1 ||
                !stored.state.deviceId ||
                !Array.isArray(stored.state.sessions) ||
                !Array.isArray(stored.state.answers) ||
                !Array.isArray(stored.state.cards) ||
                !Array.isArray(stored.state.outbox) ||
                !Array.isArray(stored.state.reviewedAnswerIds))
        )
            throw new Error("Stored mobile data uses an unsupported format.");
        if (stored.state?.catalog) validateCatalog(stored.state.catalog);
        this.revision = stored.revision;
        this.current = stored.state ?? {
            schemaVersion: 1,
            deviceId: this.deviceId ?? this.id(),
            catalog: null,
            cards: [],
            answers: [],
            reviewedAnswerIds: [],
            sessions: [],
            outbox: [],
            syncCursor: null,
        };
        if (!stored.state)
            this.revision = await this.repository.save(
                this.revision,
                this.current,
            );
        if (this.deviceId && this.current.deviceId !== this.deviceId) {
            if (this.current.outbox.length)
                throw new Error(
                    "This cache has unsynced answers from another device. Use the original device identity to sync them.",
                );
            this.current.deviceId = this.deviceId;
            this.revision = await this.repository.save(
                this.revision,
                this.current,
            );
        }
        return this.state;
    }
    private mutate<T>(operation: (state: MobileState) => T): Promise<T> {
        const next = this.pending
            .catch(() => {})
            .then(async () => {
                const copy = this.state;
                const result = operation(copy);
                const revision = await this.repository.save(
                    this.revision,
                    copy,
                );
                this.current = copy;
                this.revision = revision;
                return structuredClone(result);
            });
        this.pending = next;
        return next;
    }
    private event(
        state: MobileState,
        payload: EventPayload,
        catalogRevision = state.catalog?.revision ?? "",
    ): void {
        if (state.catalog?.isSample) return;
        state.outbox.push({
            id: this.id(),
            deviceId: state.deviceId,
            occurredAt: this.now().toISOString(),
            catalogRevision,
            ...payload,
        } as MobileEvent);
    }
    installCatalog(catalog: MobileCatalog): Promise<void> {
        return this.mutate((state) => applyCatalog(state, catalog));
    }
    startSession(
        setId: string,
        mode: StudyMode,
        questionCount = 10,
    ): Promise<ExerciseSession> {
        return this.mutate((state) => {
            const set = state.catalog?.sets.find((set) => set.id === setId);
            if (!set) throw new Error("This study set is no longer available.");
            if (mode === "study" && set.isStudying === false)
                throw new Error(
                    "This note is not in Studying. Use Practice or move it on desktop.",
                );
            const settings: PracticeSettings = {
                ...defaultPracticeSettings,
                difficulties: [0, 1, 2],
                questionCount,
                reuseQuestions: true,
                topicIds: [],
            };
            const selection = selectExerciseQuestions(
                mobileNote(state, set),
                settings,
                mode,
                this.now(),
            );
            const questions = selection.questionIds.map((id) =>
                structuredClone(
                    set.questions.find((question) => question.id === id)!,
                ),
            );
            const session: MobileSession = {
                catalogRevision: state.catalog!.revision,
                id: this.id(),
                noteId: setId,
                mode,
                settings,
                questions,
                noteTitle: set.title,
                maxPoints: questions.length,
                warnings: selection.warnings,
                createdAt: this.now().toISOString(),
                reviewedAt: null,
                closedAt: null,
                revision: 0,
                draftAnswers: [],
                scheduledQuestionIds: [],
                pendingReviewQuestionIds: [],
            };
            state.sessions.push(session);
            return session;
        });
    }
    saveAnswer(
        exerciseId: string,
        draft: ExerciseDraftAnswer,
    ): Promise<ExerciseSession> {
        return this.mutate((state) => {
            const session = state.sessions.find(
                (session) => session.id === exerciseId,
            );
            if (!session || session.closedAt)
                throw new Error("This session is no longer editable.");
            const question = session.questions.find(
                (question) => question.id === draft.questionId,
            );
            if (!question)
                throw new Error("The answer does not belong to this session.");
            const previous = session.draftAnswers.find(
                (answer) => answer.questionId === draft.questionId,
            );
            if (draft.drawing)
                throw new Error("Drawing answers are not supported on mobile.");
            const answer = structuredClone(draft);
            answer.editorMode = "text";
            if (question.format === 0) {
                const index = answer.selectedChoiceIndex;
                if (
                    index !== null &&
                    (!Number.isInteger(index) ||
                        index < 0 ||
                        index >= question.choices.length)
                )
                    throw new Error("Choose a valid answer.");
                answer.text = index === null ? "" : question.choices[index];
                answer.grade = automaticGrade(question, answer);
            } else {
                if (
                    answer.selectedChoiceIndex !== null ||
                    [...answer.text].length > question.maxCharacters
                )
                    throw new Error("The answer exceeds the allowed length.");
                if (
                    answer.grade &&
                    (answer.grade.source !== "self" ||
                        ![0, 0.5, 1].includes(answer.grade.points))
                )
                    throw new Error("Choose a valid self grade.");
            }
            if (answer.revealed && !answer.text.trim())
                throw new Error(
                    "Enter an answer before revealing the example.",
                );
            if (!answer.revealed && answer.grade)
                throw new Error("Reveal the answer before grading it.");
            if (
                previous?.revealed &&
                (previous.text !== answer.text ||
                    previous.selectedChoiceIndex !==
                        answer.selectedChoiceIndex ||
                    !answer.revealed)
            )
                throw new Error("Submitted answers cannot be edited.");
            if (
                previous?.grade &&
                JSON.stringify(previous.grade) !== JSON.stringify(answer.grade)
            )
                throw new Error("This answer has already been graded.");
            session.draftAnswers = [
                ...session.draftAnswers.filter(
                    (item) => item.questionId !== answer.questionId,
                ),
                answer,
            ];
            session.revision++;
            if (answer.grade && !previous?.grade) {
                const saved: Answer = {
                    id: this.id(),
                    exerciseId,
                    mode: session.mode,
                    questionId: question.id,
                    text: answer.text,
                    points: answer.grade.points,
                    feedback: answer.grade.feedback,
                    answeredAt: this.now().toISOString(),
                };
                state.answers.push(saved);
                this.event(
                    state,
                    {
                        kind: "answer.graded",
                        payload: {
                            noteId: session.noteId,
                            answer: saved,
                            question: structuredClone(question),
                        },
                    },
                    session.catalogRevision,
                );
                const stored = state.cards.find(
                    (card) => card.questionId === question.id,
                );
                if (
                    session.mode === "study" &&
                    question.isBasicQuestion &&
                    stored &&
                    !session.scheduledQuestionIds?.includes(question.id)
                ) {
                    const review = scheduleReview({
                        questionId: question.id,
                        beforeCard: stored.fsrsData,
                        reviewedAt: saved.answeredAt,
                        points: answer.grade.points,
                        rating:
                            answer.grade.points === 0
                                ? 1
                                : answer.grade.points === 0.5
                                  ? 2
                                  : 3,
                    });
                    stored.fsrsData = review.afterCard;
                    session.scheduledQuestionIds = [
                        ...(session.scheduledQuestionIds ?? []),
                        question.id,
                    ];
                    state.reviewedAnswerIds.push(saved.id);
                    this.event(
                        state,
                        {
                            kind: "review.applied",
                            payload: { answerId: saved.id, exerciseId, review },
                        },
                        session.catalogRevision,
                    );
                }
            }
            return session;
        });
    }
    finishSession(exerciseId: string): Promise<ExerciseSession> {
        return this.mutate((state) => {
            const session = state.sessions.find(
                (session) => session.id === exerciseId,
            );
            if (!session || session.closedAt)
                throw new Error("This session is closed.");
            if (
                session.questions.some(
                    (question) =>
                        !session.draftAnswers.some(
                            (answer) =>
                                answer.questionId === question.id &&
                                answer.revealed,
                        ),
                )
            )
                throw new Error(
                    "Answer each question before reviewing the session.",
                );
            session.reviewedAt ??= this.now().toISOString();
            session.revision++;
            return session;
        });
    }
    closeSession(exerciseId: string, discardUngraded = false): Promise<void> {
        return this.mutate((state) => {
            const session = state.sessions.find(
                (session) => session.id === exerciseId,
            );
            if (!session) throw new Error("Session not found.");
            if (session.closedAt) return;
            if (
                !discardUngraded &&
                session.draftAnswers.some(
                    (answer) => answer.text.trim() && !answer.grade,
                )
            )
                throw new Error(
                    "Grade your answers or confirm discarding ungraded answers.",
                );
            session.draftAnswers = session.draftAnswers.filter(
                (answer) => answer.revealed && answer.grade,
            );
            session.closedAt = this.now().toISOString();
            session.maxPoints = session.draftAnswers.length;
            session.revision++;
            this.event(
                state,
                {
                    kind: "session.closed",
                    payload: {
                        exerciseId,
                        noteId: session.noteId,
                        answerIds: state.answers
                            .filter(
                                (answer) => answer.exerciseId === exerciseId,
                            )
                            .map((answer) => answer.id),
                    },
                },
                session.catalogRevision,
            );
        });
    }
    /** Network failures never acknowledge events. New edits during exchange stay queued. */
    async synchronize(transport: MobileSyncTransport): Promise<void> {
        if (this.synchronizing)
            throw new Error("Synchronization is already in progress.");
        this.synchronizing = true;
        try {
            const initialIds = new Set(
                this.state.outbox.map((event) => event.id),
            );
            for (let page = 0; page < 1000; page++) {
                const snapshot = this.state;
                const outgoing = syncBatch(
                    snapshot.outbox.filter((event) => initialIds.has(event.id)),
                );
                const sent = new Set(outgoing.map((event) => event.id));
                const response = await transport.exchange({
                    schemaVersion: 1,
                    deviceId: snapshot.deviceId,
                    cursor: snapshot.syncCursor,
                    events: outgoing,
                });
                if (
                    typeof response.cursor !== "string" ||
                    !Array.isArray(response.acknowledgedIds) ||
                    response.acknowledgedIds.some((id) => !sent.has(id)) ||
                    (response.hasMore &&
                        response.cursor === snapshot.syncCursor)
                )
                    throw new Error("Invalid synchronization acknowledgement.");
                if (outgoing.length && !response.acknowledgedIds.length)
                    throw new Error(
                        "The server did not acknowledge pending changes. Try again.",
                    );
                if (response.catalog) validateCatalog(response.catalog);
                const changes = response.events ?? [];
                if (!Array.isArray(changes))
                    throw new Error("Invalid synchronized history.");
                for (const change of changes) {
                    if (
                        !change.event ||
                        ![
                            "answer.graded",
                            "review.applied",
                            "session.closed",
                        ].includes(change.event.kind)
                    )
                        throw new Error("Invalid synchronized event.");
                    if (change.event.kind === "answer.graded") {
                        const { answer, question, noteId } =
                            change.event.payload;
                        if (
                            !answer ||
                            !question ||
                            answer.questionId !== question.id ||
                            noteId !== question.noteId ||
                            ![0, 0.5, 1].includes(answer.points as number)
                        )
                            throw new Error("Invalid synchronized answer.");
                    }
                }
                await this.mutate((state) => {
                    const acknowledged = new Set(response.acknowledgedIds);
                    state.outbox = state.outbox.filter(
                        (event) => !acknowledged.has(event.id),
                    );
                    if (
                        response.catalog &&
                        response.catalog.revision !== state.catalog?.revision
                    )
                        applyCatalog(state, response.catalog);
                    const known = new Set(
                        state.answers.map((answer) => answer.id),
                    );
                    const reviewed = new Set(state.reviewedAnswerIds);
                    for (const change of changes)
                        if (change.event.kind === "answer.graded") {
                            const { answer, question } = change.event.payload;
                            if (!known.has(answer.id)) {
                                state.answers.push(structuredClone(answer));
                                known.add(answer.id);
                            }
                            if (
                                answer.mode === "study" &&
                                question.isBasicQuestion
                            )
                                reviewed.add(answer.id);
                        }
                    state.reviewedAnswerIds = [...reviewed];
                    state.syncCursor = response.cursor;
                });
                if (
                    !response.hasMore &&
                    !this.state.outbox.some((event) => initialIds.has(event.id))
                )
                    return;
            }
            throw new Error(
                "More history is available. Sync again to continue.",
            );
        } finally {
            this.synchronizing = false;
        }
    }
}
