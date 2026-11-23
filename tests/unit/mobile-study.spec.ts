import { expect, test } from "@playwright/test";
import { MobileStudyService } from "../../src/lib/mobile/study";
import { sampleCatalog } from "../../src/lib/mobile/sample";
import type {
    MobileRepository,
    MobileState,
    StoredMobileState,
    MobileSyncTransport,
} from "../../src/lib/mobile/types";
import type {
    ExerciseDraftAnswer,
    ExerciseSession,
} from "../../src/lib/types/exercises";

class MemoryRepository implements MobileRepository {
    stored: StoredMobileState = { revision: 0, state: null };
    failNext = false;
    async load() {
        return structuredClone(this.stored);
    }
    async save(revision: number, state: MobileState) {
        if (this.failNext) {
            this.failNext = false;
            throw new Error("Storage unavailable");
        }
        if (revision !== this.stored.revision) throw new Error("Stale write");
        this.stored = { revision: revision + 1, state: structuredClone(state) };
        return revision + 1;
    }
}
function testCatalog(date: Date) {
    const catalog = sampleCatalog(date);
    delete catalog.isSample;
    return catalog;
}
const now = new Date("2026-11-24T12:00:00Z");
async function setup() {
    const repository = new MemoryRepository();
    const service = new MobileStudyService(repository, () => now);
    await service.load();
    await service.installCatalog(testCatalog(now));
    return { repository, service };
}
function choice(session: ExerciseSession): ExerciseDraftAnswer {
    const question = session.questions.find(
        (question) => question.format === 0,
    )!;
    if (question.format !== 0)
        throw new Error("Missing multiple-choice question");
    return {
        questionId: question.id,
        selectedChoiceIndex: question.correctChoiceIndex,
        text: "",
        revealed: true,
    };
}

test("mobile keeps a durable device identity and starts with an empty library", async () => {
    const repository = new MemoryRepository();
    const first = new MobileStudyService(repository);
    const empty = await first.load();
    expect(empty.catalog).toBeNull();
    expect(empty.outbox).toEqual([]);
    const second = new MobileStudyService(repository);
    expect((await second.load()).deviceId).toBe(empty.deviceId);
});

test("mobile saves drafts, grades choices, and schedules each Study review atomically once", async () => {
    const { repository, service } = await setup();
    const session = await service.startSession("sample-intervals", "study", 3);
    const answer = choice(session);
    await service.saveAnswer(session.id, { ...answer, revealed: false });
    expect(service.state.answers).toEqual([]);
    const reopened = new MobileStudyService(repository, () => now);
    await reopened.load();
    expect(reopened.state.sessions[0].draftAnswers[0].selectedChoiceIndex).toBe(
        answer.selectedChoiceIndex,
    );
    await reopened.saveAnswer(session.id, answer);
    expect(reopened.state.answers).toHaveLength(1);
    expect(reopened.state.answers[0].points).toBe(1);
    expect(reopened.state.outbox.map((event) => event.kind)).toEqual([
        "answer.graded",
        "review.applied",
    ]);
    expect(reopened.state.reviewedAnswerIds).toEqual([
        reopened.state.answers[0].id,
    ]);
    const cards = structuredClone(reopened.state.cards);
    await reopened.saveAnswer(session.id, answer);
    expect(reopened.state.outbox).toHaveLength(2);
    expect(reopened.state.cards).toEqual(cards);
    await expect(
        reopened.saveAnswer(session.id, { ...answer, selectedChoiceIndex: 3 }),
    ).rejects.toThrow("Submitted answers");
    expect((await repository.load()).state).toEqual(reopened.state);
});

test("mobile Practice self grades without changing FSRS and confirms discarding ungraded work", async () => {
    const { repository, service } = await setup();
    const session = await service.startSession(
        "sample-intervals",
        "practice",
        3,
    );
    const cards = structuredClone(service.state.cards);
    const freeform = session.questions.find(
        (question) => question.format === 1,
    )!;
    await expect(
        service.saveAnswer(session.id, {
            questionId: freeform.id,
            text: "",
            selectedChoiceIndex: null,
            revealed: true,
        }),
    ).rejects.toThrow("Enter an answer");
    await service.saveAnswer(session.id, choice(session));
    await service.saveAnswer(session.id, {
        questionId: freeform.id,
        text: "A partial explanation",
        selectedChoiceIndex: null,
        revealed: true,
    });
    await expect(service.closeSession(session.id)).rejects.toThrow(
        "Grade your answers",
    );
    await expect(
        service.saveAnswer(session.id, {
            questionId: freeform.id,
            text: "A partial explanation",
            selectedChoiceIndex: null,
            revealed: true,
            grade: { points: 0.5, source: "ai", feedback: "" },
        }),
    ).rejects.toThrow("self grade");
    await service.closeSession(session.id, true);
    expect(service.state.sessions[0].draftAnswers).toHaveLength(1);
    expect(service.state.answers).toHaveLength(1);
    expect(service.state.cards).toEqual(cards);
    expect(service.state.outbox.map((event) => event.kind)).toEqual([
        "answer.graded",
        "session.closed",
    ]);
    await service.closeSession(session.id, true);
    expect(service.state.outbox).toHaveLength(2);
    const reopened = new MobileStudyService(repository);
    await reopened.load();
    expect(reopened.state.sessions[0].closedAt).not.toBeNull();
    expect(reopened.state.sessions[0].draftAnswers[0].grade?.points).toBe(1);
});

test("a mobile self grade updates Study recall from correctness and finish requires submitted answers", async () => {
    const { service } = await setup();
    const session = await service.startSession("sample-intervals", "study", 3);
    const question = session.questions.find(
        (question) => question.format === 1,
    )!;
    const answer: ExerciseDraftAnswer = {
        questionId: question.id,
        text: "Some reasoning",
        selectedChoiceIndex: null,
        revealed: true,
    };
    await service.saveAnswer(session.id, answer);
    await expect(service.finishSession(session.id)).rejects.toThrow(
        "Answer each question",
    );
    await service.saveAnswer(session.id, {
        ...answer,
        grade: { points: 0.5, source: "self", feedback: "" },
    });
    const review = service.state.outbox.find(
        (event) => event.kind === "review.applied",
    );
    expect(
        review?.kind === "review.applied" && review.payload.review.rating,
    ).toBe(2);
    for (const multiple of session.questions.filter(
        (question) => question.format === 0,
    )) {
        if (multiple.format !== 0) continue;
        await service.saveAnswer(session.id, {
            questionId: multiple.id,
            text: "",
            selectedChoiceIndex: multiple.correctChoiceIndex,
            revealed: true,
        });
    }
    expect((await service.finishSession(session.id)).reviewedAt).toBe(
        now.toISOString(),
    );
    await service.closeSession(session.id);
    expect(service.state.answers).toHaveLength(3);
});

test("mobile storage failures retain the previous state and retry without duplicate reviews", async () => {
    const { repository, service } = await setup();
    const session = await service.startSession("sample-intervals", "study", 3);
    const before = service.state;
    repository.failNext = true;
    await expect(
        service.saveAnswer(session.id, choice(session)),
    ).rejects.toThrow("Storage unavailable");
    expect(service.state).toEqual(before);
    expect(repository.stored.state).toEqual(before);
    await service.saveAnswer(session.id, choice(session));
    expect(service.state.answers).toHaveLength(1);
    expect(service.state.outbox).toHaveLength(2);
    const stale = new MobileStudyService(repository);
    await stale.load();
    await service.startSession("sample-intervals", "practice", 1);
    await expect(
        stale.startSession("sample-intervals", "practice", 1),
    ).rejects.toThrow("Stale write");
});

test("the future sync port retries stable event IDs and only acknowledges sent events", async () => {
    const { service } = await setup();
    const session = await service.startSession("sample-intervals", "study", 3);
    await service.saveAnswer(session.id, choice(session));
    const ids = service.state.outbox.map((event) => event.id);
    await expect(
        service.synchronize({
            exchange: async () => {
                throw new Error("Offline");
            },
        }),
    ).rejects.toThrow("Offline");
    expect(service.state.outbox.map((event) => event.id)).toEqual(ids);
    await expect(
        service.synchronize({
            exchange: async () => ({
                cursor: "bad",
                acknowledgedIds: ["not-sent"],
            }),
        }),
    ).rejects.toThrow("acknowledgement");
    const transport: MobileSyncTransport = {
        exchange: async (request) => {
            expect(request.events.map((event) => event.id)).toEqual(ids);
            return { cursor: "next-page", acknowledgedIds: ids };
        },
    };
    await service.synchronize(transport);
    expect(service.state.outbox).toEqual([]);
    expect(service.state.syncCursor).toBe("next-page");
    expect(service.state.answers).toHaveLength(1);
    expect(service.state.reviewedAnswerIds).toHaveLength(1);
});

test("sync preserves answers created during exchange and their unacknowledged local schedules", async () => {
    const { service } = await setup();
    const session = await service.startSession("sample-intervals", "study", 3);
    const first = choice(session);
    await service.saveAnswer(session.id, first);
    const sent = service.state.outbox.map((event) => event.id);
    let respond!: (
        value: Awaited<ReturnType<MobileSyncTransport["exchange"]>>,
    ) => void;
    const syncing = service.synchronize({
        exchange: () => new Promise((resolve) => (respond = resolve)),
    });
    const second = session.questions.find(
        (question) => question.format === 0 && question.id !== first.questionId,
    )!;
    if (second.format !== 0) throw new Error("Missing second choice");
    await service.saveAnswer(session.id, {
        questionId: second.id,
        text: "",
        selectedChoiceIndex: 1,
        revealed: true,
    });
    const localCard = structuredClone(
        service.state.cards.find((card) => card.questionId === second.id),
    );
    const catalog = testCatalog(now);
    catalog.revision = "server-v2";
    respond({ cursor: "v2", acknowledgedIds: sent, catalog });
    await syncing;
    expect(service.state.answers).toHaveLength(2);
    expect(service.state.outbox).toHaveLength(2);
    expect(
        service.state.cards.find((card) => card.questionId === second.id),
    ).toEqual(localCard);
    expect(service.state.sessions[0].questions).toEqual(session.questions);
});

test("unsupported catalogs never replace local data", async () => {
    const { service } = await setup();
    const before = service.state;
    const invalid = [
        sampleCatalog(now),
        sampleCatalog(now),
        sampleCatalog(now),
    ];
    invalid[0].schemaVersion = 2 as 1;
    invalid[1].sets[0].questions[0].id = invalid[1].sets[0].questions[1].id;
    invalid[2].sets[0].cards[0].fsrsData.due = "invalid";
    for (const catalog of invalid)
        await expect(service.installCatalog(catalog)).rejects.toThrow();
    expect(service.state).toEqual(before);
});

test("sample progress stays local and cannot pollute a server-provided library", async () => {
    const repository = new MemoryRepository();
    const service = new MobileStudyService(repository, () => now);
    await service.load();
    await service.installCatalog(sampleCatalog(now));
    const sample = await service.startSession("sample-intervals", "study", 3);
    await service.saveAnswer(sample.id, choice(sample));
    expect(service.state.answers).toHaveLength(1);
    expect(service.state.reviewedAnswerIds).toHaveLength(1);
    expect(service.state.outbox).toEqual([]);
    await service.installCatalog(testCatalog(now));
    expect(service.state.sessions).toEqual([]);
    expect(service.state.answers).toEqual([]);
    await expect(service.installCatalog(sampleCatalog(now))).rejects.toThrow(
        "cannot replace",
    );
});

test("sessions keep their original question versions when a new catalog arrives", async () => {
    const { service } = await setup();
    const session = await service.startSession("sample-intervals", "study", 3);
    const answer = choice(session);
    const catalog = testCatalog(now);
    catalog.revision = "new-content";
    catalog.sets[0].questions.forEach(
        (question) => (question.text = "Updated question"),
    );
    await service.installCatalog(catalog);
    await service.saveAnswer(session.id, answer);
    for (const event of service.state.outbox)
        expect(event.catalogRevision).toBe("sample-v1");
    const submitted = service.state.outbox.find(
        (event) => event.kind === "answer.graded",
    );
    expect(
        submitted?.kind === "answer.graded" && submitted.payload.question.text,
    ).not.toBe("Updated question");
    const invalid = testCatalog(now);
    invalid.revision = "new-content";
    invalid.schemaVersion = 2 as 1;
    const before = service.state;
    await expect(
        service.synchronize({
            exchange: async (request) => ({
                cursor: "invalid",
                acknowledgedIds: request.events.map((event) => event.id),
                catalog: invalid,
            }),
        }),
    ).rejects.toThrow("unsupported version");
    expect(service.state).toEqual(before);
});
