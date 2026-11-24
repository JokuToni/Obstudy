import { TypeConvert } from "ts-fsrs";
import type { MobileCatalog, MobileState } from "./types";

/** Reject unsupported/incomplete payloads before changing the local catalog. */
export function validateCatalog(
    value: unknown,
): asserts value is MobileCatalog {
    const catalog = value as MobileCatalog | null;
    const invalid = () => {
        throw new Error(
            "This study catalog is invalid or uses an unsupported version.",
        );
    };
    if (
        !catalog ||
        catalog.schemaVersion !== 1 ||
        typeof catalog.revision !== "string" ||
        !catalog.revision ||
        !Array.isArray(catalog.sets)
    )
        invalid();
    if (
        catalog!.isSample !== undefined &&
        typeof catalog!.isSample !== "boolean"
    )
        invalid();
    const ids = new Set<string>();
    for (const set of catalog!.sets) {
        if (
            !set ||
            typeof set.id !== "string" ||
            !set.id ||
            ids.has(set.id) ||
            (set.isStudying !== undefined &&
                typeof set.isStudying !== "boolean") ||
            typeof set.title !== "string" ||
            !set.title.trim() ||
            !Array.isArray(set.topics) ||
            !Array.isArray(set.questions) ||
            !Array.isArray(set.cards)
        )
            invalid();
        ids.add(set.id);
        const topics = new Set(set.topics.map((topic) => topic.id));
        if (topics.size !== set.topics.length) invalid();
        for (const topic of set.topics) {
            if (
                !topic.id ||
                topic.noteId !== set.id ||
                typeof topic.title !== "string"
            )
                invalid();
            if (
                "text" in topic &&
                (typeof topic.text !== "string" ||
                    (topic.broadTopicId !== null &&
                        !set.topics.some(
                            (parent) =>
                                parent.id === topic.broadTopicId &&
                                !("text" in parent),
                        )))
            )
                invalid();
        }
        const questions = new Map(
            set.questions.map((question) => [question.id, question]),
        );
        for (const question of set.questions) {
            if (
                !question ||
                typeof question.id !== "string" ||
                !question.id ||
                ids.has(question.id) ||
                question.noteId !== set.id ||
                typeof question.text !== "string" ||
                !question.text.trim() ||
                typeof question.exampleAnswer !== "string" ||
                ![0, 1, 2].includes(question.difficulty) ||
                typeof question.isBasicQuestion !== "boolean" ||
                !Array.isArray(question.topicIds) ||
                question.topicIds.some((id) => !topics.has(id)) ||
                !Array.isArray(question.materials)
            )
                invalid();
            ids.add(question.id);
            if (question.format === 0) {
                if (
                    !Array.isArray(question.choices) ||
                    question.choices.length < 2 ||
                    question.choices.length > 8 ||
                    question.choices.some(
                        (choice) =>
                            typeof choice !== "string" || !choice.trim(),
                    ) ||
                    new Set(question.choices).size !==
                        question.choices.length ||
                    !Number.isInteger(question.correctChoiceIndex) ||
                    question.correctChoiceIndex < 0 ||
                    question.correctChoiceIndex >= question.choices.length
                )
                    invalid();
            } else if (question.format === 1) {
                if (
                    !Number.isSafeInteger(question.maxCharacters) ||
                    question.maxCharacters < 1 ||
                    typeof question.answerCriteria !== "string"
                )
                    invalid();
            } else invalid();
            for (const material of question.materials) {
                if (material.type === "image") {
                    if (
                        typeof material.source !== "string" ||
                        !/^(https:\/\/|data:image\/)/i.test(material.source) ||
                        typeof material.alt !== "string"
                    )
                        invalid();
                } else if (
                    !["latex", "code"].includes(material.type) ||
                    typeof material.content !== "string"
                )
                    invalid();
            }
        }
        const cards = new Set<string>();
        for (const stored of set.cards) {
            if (
                !questions.get(stored.questionId)?.isBasicQuestion ||
                cards.has(stored.questionId)
            )
                invalid();
            cards.add(stored.questionId);
            try {
                const card = TypeConvert.card(stored.fsrsData);
                if (
                    !Number.isFinite(card.due.getTime()) ||
                    ![0, 1, 2, 3].includes(card.state) ||
                    !Number.isFinite(card.stability) ||
                    !Number.isFinite(card.difficulty) ||
                    !Number.isSafeInteger(card.reps) ||
                    card.reps < 0
                )
                    invalid();
            } catch {
                invalid();
            }
        }
    }
}
export function applyCatalog(state: MobileState, catalog: MobileCatalog): void {
    validateCatalog(catalog);
    if (catalog.isSample && state.catalog && !state.catalog.isSample)
        throw new Error("Sample questions cannot replace your study library.");
    if (state.catalog?.isSample && !catalog.isSample) {
        state.sessions = [];
        state.answers = [];
        state.reviewedAnswerIds = [];
        state.outbox = [];
    }
    const pending = new Set(
        state.outbox
            .filter((event) => event.kind === "review.applied")
            .map((event) =>
                event.kind === "review.applied"
                    ? event.payload.review.questionId
                    : "",
            ),
    );
    const local = new Map(state.cards.map((card) => [card.questionId, card]));
    state.cards = catalog.sets.flatMap((set) =>
        set.cards.map((card) =>
            pending.has(card.questionId)
                ? (local.get(card.questionId) ?? card)
                : card,
        ),
    );
    state.catalog = structuredClone(catalog);
}
