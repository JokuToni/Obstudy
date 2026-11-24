import { syncBatch } from "./batch";
import { invoke } from "@tauri-apps/api/core";
import { cloudRequest, CloudError, serverUrl } from "./client";
import { validateCatalog } from "../mobile/catalog";
import type { CloudHistoryRecord, CloudExchange, CloudSession } from "./types";
import type {
    MobileCatalog,
    MobileEvent,
    MobileStudySet,
} from "../mobile/types";
import type { SyncedNote } from "../types/notes";
import type { Question } from "../types";

type LocalRecord = CloudHistoryRecord;
interface DesktopState {
    schemaVersion: 1;
    catalog: MobileCatalog | null;
    cursor: string | null;
    knownAnswerIds: string[];
    knownClosedIds?: string[];
    baselineRecords: CloudHistoryRecord[];
    outbox: MobileEvent[];
    ownedNoteIds: string[];
    questionVersions?: { revision: string; question: Question }[];
    resetQueue?: { id: string; questionIds: string[]; baseRevision?: string }[];
}
interface Snapshot {
    revision: number;
    state: DesktopState | null;
    notes: SyncedNote[];
    records: LocalRecord[];
    closedSessions?: {
        exerciseId: string;
        noteId: string;
        closedAt: string;
        answerIds: string[];
    }[];
}
/** Native question snapshots also contain UI-only broadTopicIds; publish only wire fields. */
export function portableQuestion(question: Question): Question {
    const {
        id,
        noteId,
        isBasicQuestion,
        generatedAt,
        generatedWithModel,
        generationScope,
        text,
        exampleAnswer,
        lastAnsweredAt,
        averageScore,
        topicIds,
        difficulty,
        materials,
    } = question;
    const base = {
        id,
        noteId,
        isBasicQuestion,
        generatedAt: generatedAt ?? null,
        generatedWithModel: generatedWithModel ?? null,
        generationScope: generationScope ?? null,
        text,
        exampleAnswer,
        lastAnsweredAt: lastAnsweredAt ?? null,
        averageScore,
        topicIds: [...topicIds],
        difficulty,
        materials: structuredClone(materials),
    };
    return question.format === 0
        ? {
              ...base,
              format: 0,
              choices: [...question.choices],
              correctChoiceIndex: question.correctChoiceIndex,
          }
        : {
              ...base,
              format: 1,
              maxCharacters: question.maxCharacters,
              answerCriteria: question.answerCriteria,
          };
}
function recordForWire(record: CloudHistoryRecord): CloudHistoryRecord {
    const answer = { ...record.answer };
    if (!answer.exerciseId || !answer.mode)
        throw new Error(
            "A saved answer has no session identity and cannot be synchronized.",
        );
    return {
        noteId: record.noteId,
        answer,
        question: portableQuestion(record.question),
    };
}
function questionIdentity(question: Question): string {
    const { averageScore, lastAnsweredAt, topicIds, ...identity } =
        portableQuestion(question);
    return JSON.stringify(identity);
}
function content(catalog: MobileCatalog): string {
    return JSON.stringify(
        catalog.sets
            .map((set) => ({
                ...set,
                cards: set.cards.map((card) => ({
                    questionId: card.questionId,
                })),
                questions: set.questions.map(
                    ({ lastAnsweredAt, averageScore, ...question }) => question,
                ),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
    );
}
export function buildDesktopCatalog(
    snapshot: Snapshot,
    state: DesktopState,
): MobileCatalog {
    const remote = state.catalog?.sets ?? [];
    const owned = new Set(state.ownedNoteIds);
    const sets: MobileStudySet[] = remote.filter((set) => !owned.has(set.id));
    for (const note of snapshot.notes) {
        if (!note.isAvailable) continue;
        if (note.parseError || note.syncIssues.length) {
            const previous = remote.find((set) => set.id === note.id);
            if (previous) sets.push(previous);
            continue;
        }
        const topicIds = new Set(note.topics.map((topic) => topic.id));
        const questions = note.questions.map((question) => ({
            ...portableQuestion(question),
            topicIds: question.topicIds.filter((id) => topicIds.has(id)),
        }));
        const ids = new Set(questions.map((question) => question.id));
        const cards = note.questionFsrs.filter((card) =>
            ids.has(card.questionId),
        );
        sets.push({
            id: note.id,
            title:
                note.file.path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ??
                note.file.path,
            isStudying: note.isStudying,
            topics: note.topics,
            questions,
            cards,
        });
    }
    return { schemaVersion: 1, revision: "desktop-draft", sets };
}
let pending: Promise<unknown> = Promise.resolve();
export function synchronizeDesktop(
    folderPath: string,
    session: CloudSession,
): Promise<void> {
    const next = pending
        .catch(() => {})
        .then(() => performSync(folderPath, session));
    pending = next;
    return next;
}
async function performSync(
    folderPath: string,
    session: CloudSession,
): Promise<void> {
    const base = serverUrl();
    if (!base) throw new Error("Configure the study server first.");
    try {
        const capabilities = await cloudRequest<{ features: string[] }>(
            "/v1/capabilities",
        );
        if (
            !Array.isArray(capabilities.features) ||
            !capabilities.features.includes("history-import") ||
            !capabilities.features.includes("schedule-reset")
        )
            throw new Error(
                "The study server needs an update before this desktop version can sync.",
            );
    } catch (error) {
        if (error instanceof CloudError && error.status === 404)
            throw new Error(
                "The study server needs an update. Deploy the API changes before connecting this desktop version.",
            );
        throw error;
    }
    let snapshot = await invoke<Snapshot>("cloud_desktop_snapshot", {
        folderPath,
        userId: session.userId,
        serverUrl: base,
    });
    let revision = snapshot.revision;
    let state: DesktopState = snapshot.state ?? {
        schemaVersion: 1,
        catalog: null,
        cursor: null,
        knownAnswerIds: snapshot.records.map((record) => record.answer.id),
        knownClosedIds:
            snapshot.closedSessions?.map((session) => session.exerciseId) ?? [],
        baselineRecords: snapshot.records.map(recordForWire),
        outbox: [],
        ownedNoteIds: snapshot.notes.map((note) => note.id),
    };
    if (state.schemaVersion !== 1)
        throw new Error(
            "This desktop sync cache needs a newer version of Obstudy.",
        );
    async function commit(
        catalog?: MobileCatalog,
        records: CloudHistoryRecord[] = [],
    ): Promise<void> {
        revision = await invoke<number>("cloud_desktop_commit", {
            folderPath,
            userId: session.userId,
            serverUrl: base,
            expectedRevision: revision,
            state,
            catalog: catalog ?? null,
            records,
        });
    }
    function remember(catalog: MobileCatalog): void {
        state.questionVersions ??= [];
        for (const question of catalog.sets.flatMap((set) => set.questions)) {
            if (
                !state.questionVersions.some(
                    (entry) =>
                        questionIdentity(entry.question) ===
                        questionIdentity(question),
                )
            )
                state.questionVersions.push({
                    revision: catalog.revision,
                    question: structuredClone(question),
                });
        }
    }
    if (state.catalog) remember(state.catalog);
    function enqueueRecords(requirePublished: boolean): void {
        const known = new Set([
            ...state.knownAnswerIds,
            ...state.outbox
                .filter((event) => event.kind === "answer.graded")
                .map((event) =>
                    event.kind === "answer.graded"
                        ? event.payload.answer.id
                        : "",
                ),
        ]);
        for (const record of snapshot.records) {
            if (known.has(record.answer.id)) continue;
            const wire = recordForWire(record);
            const published = state.questionVersions?.find(
                (entry) =>
                    questionIdentity(entry.question) ===
                    questionIdentity(wire.question),
            );
            if (!published) {
                const knownQuestion = state.questionVersions?.some(
                    (entry) => entry.question.id === wire.question.id,
                );
                if (!knownQuestion) {
                    state.baselineRecords.push(wire);
                    state.knownAnswerIds.push(wire.answer.id);
                    known.add(wire.answer.id);
                    continue;
                }
                if (requirePublished)
                    throw new Error(
                        "An answered question has not been published yet. Resolve its note warnings and sync again.",
                    );
                continue;
            }
            state.outbox.push({
                id: crypto.randomUUID(),
                deviceId: session.deviceId,
                occurredAt: new Date().toISOString(),
                catalogRevision: published.revision,
                kind: "answer.graded",
                payload: wire,
            });
            known.add(record.answer.id);
        }
    }
    // Freeze the baseline and all event IDs before doing network work.
    if (!snapshot.state) await commit();
    async function exchange(): Promise<void> {
        for (let page = 0; page < 1000; page++) {
            const sent = syncBatch(state.outbox);
            const response = await cloudRequest<CloudExchange>(
                "/v1/sync",
                "POST",
                {
                    schemaVersion: 1,
                    deviceId: session.deviceId,
                    cursor: state.cursor,
                    events: sent,
                },
            );
            if (
                typeof response.cursor !== "string" ||
                !Array.isArray(response.acknowledgedIds) ||
                response.acknowledgedIds.some(
                    (id) => !sent.some((event) => event.id === id),
                )
            )
                throw new Error(
                    "Invalid server acknowledgement. No local events were discarded.",
                );
            if (response.catalog) {
                validateCatalog(response.catalog);
                remember(response.catalog);
            }
            const acknowledged = new Set(response.acknowledgedIds);
            const records: CloudHistoryRecord[] = [];
            for (const change of response.events ?? [])
                if (change.event.kind === "answer.graded")
                    records.push(recordForWire(change.event.payload));
            const ids = new Set(state.knownAnswerIds);
            for (const event of sent)
                if (
                    acknowledged.has(event.id) &&
                    event.kind === "answer.graded"
                )
                    ids.add(event.payload.answer.id);
            for (const record of records) ids.add(record.answer.id);
            const closed = new Set(state.knownClosedIds ?? []);
            for (const event of sent)
                if (
                    acknowledged.has(event.id) &&
                    event.kind === "session.closed"
                )
                    closed.add(event.payload.exerciseId);
            state = {
                ...state,
                knownAnswerIds: [...ids],
                knownClosedIds: [...closed],
                outbox: state.outbox.filter(
                    (event) => !acknowledged.has(event.id),
                ),
                catalog: response.catalog ?? state.catalog,
                cursor: response.cursor,
            };
            await commit(response.catalog, records);
            if (!response.hasMore && !state.outbox.length) return;
        }
        throw new Error(
            "The server has more history to download. Sync again to continue.",
        );
    }
    // Flush sessions created against an earlier catalog before publishing removals.
    await exchange();
    while (state.resetQueue?.length && state.catalog) {
        const operation = state.resetQueue[0];
        operation.baseRevision ??= state.catalog.revision;
        await commit();
        let reset: { catalog: MobileCatalog };
        try {
            reset = await cloudRequest<{ catalog: MobileCatalog }>(
                "/v1/cards/reset",
                "POST",
                operation,
            );
        } catch (error) {
            if (error instanceof CloudError && error.status === 409) {
                delete operation.baseRevision;
                await commit();
            }
            throw error;
        }
        validateCatalog(reset.catalog);
        state.catalog = reset.catalog;
        state.resetQueue.shift();
        await commit(reset.catalog);
    }
    snapshot = await invoke<Snapshot>("cloud_desktop_snapshot", {
        folderPath,
        userId: session.userId,
        serverUrl: base,
    });
    revision = snapshot.revision;
    enqueueRecords(false);
    await commit();
    if (state.outbox.length) await exchange();
    const desired = buildDesktopCatalog(snapshot, state);
    if (!state.catalog || content(desired) !== content(state.catalog)) {
        try {
            const response = await cloudRequest<{ catalog: MobileCatalog }>(
                "/v1/library",
                "PUT",
                {
                    baseRevision: state.catalog?.revision ?? null,
                    catalog: desired,
                },
                false,
            );
            validateCatalog(response.catalog);
            remember(response.catalog);
            state.catalog = response.catalog;
            state.ownedNoteIds = [
                ...new Set([
                    ...state.ownedNoteIds,
                    ...snapshot.notes.map((note) => note.id),
                ]),
            ];
            await commit();
        } catch (error) {
            if (error instanceof CloudError && error.status === 409)
                throw new Error(
                    "The shared library changed on another device. Sync again to review the latest library before publishing your changes.",
                );
            throw error;
        }
    }
    while (state.baselineRecords.length) {
        const batch = syncBatch(state.baselineRecords);
        const response = await cloudRequest<{ acknowledgedIds: string[] }>(
            "/v1/history/import",
            "POST",
            { records: batch },
        );
        if (
            !Array.isArray(response.acknowledgedIds) ||
            batch.some(
                (record) =>
                    !response.acknowledgedIds.includes(record.answer.id),
            )
        )
            throw new Error(
                "History import was not acknowledged. It will be retried safely.",
            );
        state.baselineRecords = state.baselineRecords.slice(batch.length);
        await commit();
    }
    enqueueRecords(true);
    const closed = new Set([
        ...(state.knownClosedIds ?? []),
        ...state.outbox
            .filter((event) => event.kind === "session.closed")
            .map((event) =>
                event.kind === "session.closed" ? event.payload.exerciseId : "",
            ),
    ]);
    for (const completed of snapshot.closedSessions ?? []) {
        if (closed.has(completed.exerciseId)) continue;
        const version = state.catalog?.sets.some(
            (set) => set.id === completed.noteId,
        )
            ? state.catalog.revision
            : state.questionVersions?.find(
                  (entry) => entry.question.noteId === completed.noteId,
              )?.revision;
        if (!version) continue;
        state.outbox.push({
            id: crypto.randomUUID(),
            deviceId: session.deviceId,
            occurredAt: completed.closedAt,
            catalogRevision: version,
            kind: "session.closed",
            payload: {
                exerciseId: completed.exerciseId,
                noteId: completed.noteId,
                answerIds: completed.answerIds,
            },
        });
        closed.add(completed.exerciseId);
    }
    await commit();
    await exchange();
}
