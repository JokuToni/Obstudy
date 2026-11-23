import { z } from "zod";
import { requireValue } from "./errors.js";

export const idSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/);
export const timestampSchema = z.iso.datetime({ offset: true });
const text = z.string().max(200_000);
const nullableText = text.nullable();
export const cardSchema = z.strictObject({
    due: timestampSchema,
    stability: z.number().min(0).max(1e9),
    difficulty: z.number().min(0).max(10),
    elapsed_days: z.number().min(0).max(1e9),
    scheduled_days: z.number().min(0).max(1e9),
    learning_steps: z.number().int().min(0).max(1e6),
    reps: z.number().int().min(0).max(1e9),
    lapses: z.number().int().min(0).max(1e9),
    state: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    last_review: timestampSchema.optional(),
});
const topicBase = {
    id: idSchema,
    noteId: idSchema,
    title: z.string().min(1).max(1000),
};
const topicSchema = z.union([
    z.strictObject(topicBase),
    z.strictObject({ ...topicBase, broadTopicId: idSchema.nullable(), text }),
]);
const materialSchema = z.discriminatedUnion("type", [
    z.strictObject({
        type: z.literal("image"),
        source: z
            .string()
            .max(1_000_000)
            .regex(/^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i),
        alt: text,
    }),
    z.strictObject({ type: z.literal("latex"), content: text }),
    z.strictObject({
        type: z.literal("code"),
        content: text,
        language: z.string().max(100).nullable(),
    }),
]);
const questionBase = {
    id: idSchema,
    noteId: idSchema,
    isBasicQuestion: z.boolean(),
    generatedAt: timestampSchema.nullable(),
    generatedWithModel: nullableText,
    generationScope: nullableText,
    text: text.min(1),
    exampleAnswer: text,
    lastAnsweredAt: timestampSchema.nullable(),
    averageScore: z.number().min(0).max(1),
    topicIds: z.array(idSchema).max(1000),
    difficulty: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    materials: z.array(materialSchema).max(50),
};
export const questionSchema = z.discriminatedUnion("format", [
    z.strictObject({
        ...questionBase,
        format: z.literal(0),
        choices: z.array(text.min(1)).min(2).max(8),
        correctChoiceIndex: z.number().int().min(0).max(7),
    }),
    z.strictObject({
        ...questionBase,
        format: z.literal(1),
        maxCharacters: z.number().int().min(1).max(200_000),
        answerCriteria: text,
    }),
]);
export const catalogSchema = z.strictObject({
    schemaVersion: z.literal(1),
    revision: idSchema,
    isSample: z.literal(false).optional(),
    sets: z
        .array(
            z.strictObject({
                id: idSchema,
                title: z.string().min(1).max(1000),
                topics: z.array(topicSchema).max(5000),
                questions: z.array(questionSchema).max(20_000),
                cards: z
                    .array(
                        z.strictObject({
                            questionId: idSchema,
                            fsrsData: cardSchema,
                        }),
                    )
                    .max(20_000),
            }),
        )
        .max(1000),
});
export type Catalog = z.infer<typeof catalogSchema>;
export type Question = z.infer<typeof questionSchema>;
export const gradeSchema = z.union([
    z.literal(0),
    z.literal(0.5),
    z.literal(1),
]);
export const answerSchema = z.strictObject({
    id: idSchema,
    answeredAt: timestampSchema,
    questionId: idSchema,
    text,
    points: gradeSchema,
    exerciseId: idSchema,
    mode: z.enum(["study", "practice"]),
    feedback: text,
    drawing: z
        .strictObject({
            version: z.literal(1),
            width: z.literal(1200),
            height: z.literal(800),
            elements: z.array(z.record(z.string(), z.unknown())).max(10_000),
        })
        .nullable()
        .optional(),
});
export type Answer = z.infer<typeof answerSchema>;
const eventBase = {
    id: idSchema,
    deviceId: idSchema,
    occurredAt: timestampSchema,
    catalogRevision: idSchema,
};
export const eventSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        ...eventBase,
        kind: z.literal("answer.graded"),
        payload: z.strictObject({
            noteId: idSchema,
            answer: answerSchema,
            question: questionSchema,
        }),
    }),
    z.strictObject({
        ...eventBase,
        kind: z.literal("review.applied"),
        payload: z.strictObject({
            answerId: idSchema,
            exerciseId: idSchema,
            review: z.strictObject({
                questionId: idSchema,
                beforeCard: cardSchema,
                afterCard: cardSchema,
                reviewedAt: timestampSchema,
                rating: z.union([
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                ]),
                reviewLog: z.record(z.string(), z.unknown()),
            }),
        }),
    }),
    z.strictObject({
        ...eventBase,
        kind: z.literal("session.closed"),
        payload: z.strictObject({
            exerciseId: idSchema,
            noteId: idSchema,
            answerIds: z.array(idSchema).max(10_000),
        }),
    }),
]);
export type SyncEvent = z.infer<typeof eventSchema>;
export const cursorSchema = z
    .string()
    .regex(/^(0|[1-9]\d{0,18})$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n);
export const syncSchema = z.strictObject({
    schemaVersion: z.literal(1),
    deviceId: idSchema,
    cursor: cursorSchema.nullable(),
    events: z.array(eventSchema).max(500),
});
export const uploadSchema = z.strictObject({
    baseRevision: idSchema.nullable(),
    catalog: catalogSchema,
});
export const credentialsSchema = z.strictObject({
    email: z.email().max(254),
    password: z.string().min(12).max(256),
    deviceId: idSchema,
    deviceName: z.string().min(1).max(100),
});
export const passwordSchema = z.strictObject({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
});
export const deleteAccountSchema = z.strictObject({
    password: z.string().min(1).max(256),
});
export const pageSchema = z.strictObject({
    after: cursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
});
export function validateCatalog(catalog: Catalog): void {
    const globalIds = new Set<string>();
    for (const set of catalog.sets) {
        requireValue(!globalIds.has(set.id), "Duplicate note ID.");
        globalIds.add(set.id);
        const topics = new Map(set.topics.map((topic) => [topic.id, topic]));
        requireValue(topics.size === set.topics.length, "Duplicate topic ID.");
        for (const topic of set.topics) {
            requireValue(
                topic.noteId === set.id,
                "Topic belongs to another note.",
            );
            if ("text" in topic && topic.broadTopicId !== null) {
                const parent = topics.get(topic.broadTopicId);
                requireValue(
                    parent && !("text" in parent),
                    "Invalid parent topic.",
                );
            }
        }
        const questions = new Map(
            set.questions.map((question) => [question.id, question]),
        );
        for (const question of set.questions) {
            requireValue(!globalIds.has(question.id), "Duplicate question ID.");
            globalIds.add(question.id);
            requireValue(
                question.noteId === set.id &&
                    question.topicIds.every((id) => topics.has(id)),
                "Invalid question topic or note.",
            );
            if (question.format === 0)
                requireValue(
                    question.correctChoiceIndex < question.choices.length &&
                        new Set(question.choices).size ===
                            question.choices.length,
                    "Invalid multiple-choice options.",
                );
        }
        const cards = new Set<string>();
        for (const card of set.cards) {
            requireValue(
                !cards.has(card.questionId) &&
                    questions.get(card.questionId)?.isBasicQuestion,
                "Invalid or duplicate basic card.",
            );
            requireValue(
                card.fsrsData.reps === 0 || !!card.fsrsData.last_review,
                "Reviewed cards need last_review.",
            );
            cards.add(card.questionId);
        }
        requireValue(
            set.questions.every(
                (question) =>
                    !question.isBasicQuestion || cards.has(question.id),
            ),
            "Each basic question needs a card.",
        );
    }
}
