import { createEmptyCard } from "ts-fsrs";
import type {
    BroadTopic,
    Difficulty,
    QuestionFormat,
    Subtopic,
    Topic,
} from "../types/index";
import type { SyncedNote } from "../types/notes";
import type { AiResponse, AiTokenUsage } from "../types/ai";
import type {
    GeneratedQuestion,
    QuestionGenerationBatch,
    QuestionGenerationOptions,
    QuestionGenerationRequest,
    QuestionGenerationResult,
} from "../types/questions";
import {
    sharedQuestionPrompt,
    easyQuestionPrompt,
    mediumQuestionPrompt,
    hardQuestionPrompt,
} from "../prompts/questions";

export interface GenerationTask {
    scope: string;
    difficulty: Difficulty;
    format: QuestionFormat;
    targetCount: number;
    remainingCount: number;
    topics: Topic[];
}

export interface GenerationDependencies {
    loadNote: (noteId: string) => Promise<SyncedNote>;
    promptAi: (prompt: string) => Promise<AiResponse>;
    saveBatch: (batch: QuestionGenerationBatch) => Promise<SyncedNote>;
}

export class QuestionGenerationError extends Error {
    constructor(
        message: string,
        public readonly result: QuestionGenerationResult,
        public readonly details: string | null = null,
    ) {
        super(message);
        this.name = "QuestionGenerationError";
    }
}

function isSubtopic(topic: Topic): topic is Subtopic {
    return "text" in topic;
}

function validateRequest(
    request: QuestionGenerationRequest,
    note: SyncedNote,
): void {
    if (
        !Number.isSafeInteger(request.questionCount) ||
        request.questionCount < 1 ||
        request.questionCount > 1000
    ) {
        throw new Error(
            "Question count must be an integer between 1 and 1000.",
        );
    }
    if (
        ![0, 1, 2].includes(request.difficulty ?? 0) ||
        ![0, 1, 2].includes(request.questionFormat ?? 2)
    ) {
        throw new Error("Unsupported question difficulty or format.");
    }
    if (!note.isAvailable || note.parseError || note.syncIssues.length) {
        throw new Error(
            "Resolve note errors and pending topic changes before generating questions.",
        );
    }
    if (!note.topics.some(isSubtopic))
        throw new Error(
            "The note has no subtopics to generate questions from.",
        );
    if (
        request.topicIds?.some(
            (id) => !note.topics.some((topic) => topic.id === id),
        )
    ) {
        throw new Error("A selected topic does not belong to this note.");
    }
}

function topicContext(note: SyncedNote, subtopics: Subtopic[]): Topic[] {
    const parents = new Set(subtopics.map((topic) => topic.broadTopicId));
    return [
        ...note.topics.filter(
            (topic) => !isSubtopic(topic) && parents.has(topic.id),
        ),
        ...subtopics,
    ];
}

function task(
    scope: string,
    difficulty: Difficulty,
    format: QuestionFormat,
    targetCount: number,
    topics: Topic[],
): GenerationTask {
    return {
        scope,
        difficulty,
        format,
        targetCount,
        remainingCount: targetCount,
        topics,
    };
}

/** Pure deterministic plan; saved scope counts make interrupted basic generation resumable. */
export function planBasicQuestions(note: SyncedNote): GenerationTask[] {
    const subtopics = note.topics.filter(isSubtopic);
    const broadTopics = note.topics.filter(
        (topic): topic is BroadTopic => !isSubtopic(topic),
    );
    const tasks: GenerationTask[] = [];
    subtopics.forEach((subtopic, index) => {
        const multipleChoiceCount = index % 2 === 0 ? 2 : 1;
        const context = topicContext(note, [subtopic]);
        tasks.push(
            task(`easy:${subtopic.id}`, 0, 0, multipleChoiceCount, context),
        );
        tasks.push(
            task(`easy:${subtopic.id}`, 0, 1, 3 - multipleChoiceCount, context),
        );
    });
    let mediumCount = 0;
    let mediumMultipleChoiceCount = 0;
    for (const broadTopic of broadTopics) {
        const children = subtopics.filter(
            (topic) => topic.broadTopicId === broadTopic.id,
        );
        if (!children.length) continue;
        const count = children.length * 2;
        mediumCount += count;
        const nextMultipleChoiceCount = Math.round(mediumCount / 3);
        const multipleChoiceCount =
            nextMultipleChoiceCount - mediumMultipleChoiceCount;
        mediumMultipleChoiceCount = nextMultipleChoiceCount;
        const context = [broadTopic, ...children];
        tasks.push(
            task(`medium:${broadTopic.id}`, 1, 0, multipleChoiceCount, context),
        );
        tasks.push(
            task(
                `medium:${broadTopic.id}`,
                1,
                1,
                count - multipleChoiceCount,
                context,
            ),
        );
    }
    if (broadTopics.length)
        tasks.push(
            task(`hard:${note.id}`, 2, 1, broadTopics.length * 2, note.topics),
        );
    return tasks
        .filter((task) => task.targetCount > 0)
        .map((task) => ({
            ...task,
            remainingCount: Math.max(
                0,
                task.targetCount -
                    note.questions.filter(
                        (question) =>
                            question.isBasicQuestion &&
                            question.generationScope === task.scope &&
                            question.difficulty === task.difficulty &&
                            question.format === task.format,
                    ).length,
            ),
        }));
}

export function planAdditionalQuestions(
    note: SyncedNote,
    request: QuestionGenerationRequest,
): GenerationTask[] {
    const selected = new Set(request.topicIds ?? []);
    const subtopics = note.topics
        .filter(isSubtopic)
        .filter(
            (topic) =>
                !selected.size ||
                selected.has(topic.id) ||
                (topic.broadTopicId !== null &&
                    selected.has(topic.broadTopicId)),
        );
    if (!subtopics.length)
        throw new Error("The selected topics have no subtopic content.");
    const difficulty = request.difficulty ?? 0;
    let contexts: Topic[][];
    if (difficulty === 0)
        contexts = subtopics.map((topic) => topicContext(note, [topic]));
    else if (difficulty === 1) {
        const parents = [
            ...new Set(subtopics.map((topic) => topic.broadTopicId)),
        ];
        // Parentless subtopics can still support deeper application on their own.
        contexts = parents.flatMap((parent) =>
            parent === null
                ? subtopics
                      .filter((topic) => topic.broadTopicId === null)
                      .map((topic) => [topic])
                : [
                      topicContext(
                          note,
                          subtopics.filter(
                              (topic) => topic.broadTopicId === parent,
                          ),
                      ),
                  ],
        );
    } else contexts = [topicContext(note, subtopics)];
    const tasks: GenerationTask[] = [];
    let allocated = 0;
    let allocatedMultipleChoice = 0;
    const format = request.questionFormat ?? 2;
    contexts.forEach((topics, index) => {
        const count =
            Math.floor(request.questionCount / contexts.length) +
            (index < request.questionCount % contexts.length ? 1 : 0);
        if (!count) return;
        allocated += count;
        const nextMultipleChoice = Math.round(allocated / 2);
        const multipleChoice =
            format === 0
                ? count
                : format === 1
                  ? 0
                  : nextMultipleChoice - allocatedMultipleChoice;
        allocatedMultipleChoice = nextMultipleChoice;
        const scope = `additional:${difficulty}:${topics
            .filter(isSubtopic)
            .map((topic) => topic.id)
            .join(",")}`;
        if (multipleChoice)
            tasks.push(task(scope, difficulty, 0, multipleChoice, topics));
        if (count - multipleChoice)
            tasks.push(
                task(scope, difficulty, 1, count - multipleChoice, topics),
            );
    });
    return tasks;
}

function render(
    template: string,
    values: Record<string, string | number>,
): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        if (!(key in values))
            throw new Error(`Missing question prompt variable: ${key}`);
        return String(values[key]);
    });
}

export function buildQuestionPrompt(
    note: SyncedNote,
    task: GenerationTask,
    count: number,
    outputLanguage?: string,
    feedback?: string,
): string {
    const topicIds = new Set(task.topics.map((topic) => topic.id));
    const source = {
        noteTitle: note.file.path.split(/[\\/]/).pop()?.replace(/\.md$/i, ""),
        broadTopics: task.topics.filter((topic) => !isSubtopic(topic)),
        subtopics: task.topics.filter(isSubtopic),
    };
    const existing = note.questions
        .filter((question) => question.topicIds.some((id) => topicIds.has(id)))
        .map((question) => ({
            text: question.text,
            topicIds: question.topicIds,
        }));
    const instructions = [
        easyQuestionPrompt,
        mediumQuestionPrompt,
        hardQuestionPrompt,
    ][task.difficulty];
    // Render the trusted templates before inserting data; source text is never re-interpolated.
    return (
        render(`${sharedQuestionPrompt}\n\n${instructions}`, {
            questionCount: count,
            questionFormat: task.format,
            outputLanguage:
                outputLanguage?.trim() ||
                "the same language as the source notes",
            sourceJson: JSON.stringify(source),
            existingQuestionsJson: JSON.stringify(existing),
        }) +
        (feedback
            ? `\n\nValidation feedback from the previous attempt:\n${feedback}\nReturn only the missing ${count} questions, correcting these issues.`
            : "")
    );
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
function normalized(text: string): string {
    return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseGeneratedQuestions(
    text: string,
    task: GenerationTask,
    count: number,
    note: SyncedNote,
): { questions: GeneratedQuestion[]; warnings: string[] } {
    const payload: unknown = JSON.parse(text);
    if (
        !record(payload) ||
        !Array.isArray(payload.questions) ||
        !Array.isArray(payload.warnings) ||
        !payload.warnings.every((warning) => typeof warning === "string")
    ) {
        throw new Error("Expected JSON with questions and warnings arrays.");
    }
    const warnings = [...payload.warnings] as string[];
    const questions: GeneratedQuestion[] = [];
    const allowed = new Set(task.topics.map((topic) => topic.id));
    const subtopicIds = new Set(
        task.topics.filter(isSubtopic).map((topic) => topic.id),
    );
    const texts = new Set(
        note.questions.map((question) => normalized(question.text)),
    );
    for (const value of payload.questions) {
        if (questions.length >= count) {
            warnings.push(
                "Extra questions beyond the requested batch size were ignored.",
            );
            break;
        }
        try {
            if (
                !record(value) ||
                !nonempty(value.text) ||
                !nonempty(value.exampleAnswer) ||
                value.difficulty !== task.difficulty ||
                value.format !== task.format ||
                !Array.isArray(value.topicIds) ||
                !value.topicIds.length ||
                !value.topicIds.every(
                    (id) => typeof id === "string" && allowed.has(id),
                ) ||
                new Set(value.topicIds).size !== value.topicIds.length ||
                !value.topicIds.some((id) => subtopicIds.has(id as string))
            ) {
                throw new Error(
                    "Invalid question content, difficulty, format, or topic IDs.",
                );
            }
            const topicIds = new Set(value.topicIds as string[]);
            for (const topic of task.topics.filter(isSubtopic)) {
                if (
                    topicIds.has(topic.id) &&
                    topic.broadTopicId &&
                    allowed.has(topic.broadTopicId)
                )
                    topicIds.add(topic.broadTopicId);
            }
            const base = {
                text: value.text.trim(),
                exampleAnswer: value.exampleAnswer.trim(),
                topicIds: [...topicIds],
                difficulty: task.difficulty,
            };
            let question: GeneratedQuestion;
            let allowedFields = [
                "text",
                "exampleAnswer",
                "topicIds",
                "difficulty",
                "format",
            ];
            if (task.format === 0) {
                if (
                    !Array.isArray(value.choices) ||
                    value.choices.length !== 4 ||
                    !value.choices.every(nonempty) ||
                    new Set(value.choices.map(normalized)).size !== 4 ||
                    !Number.isSafeInteger(value.correctChoiceIndex) ||
                    (value.correctChoiceIndex as number) < 0 ||
                    (value.correctChoiceIndex as number) >= 4
                ) {
                    throw new Error(
                        "Multiple-choice questions need four unique choices and a valid zero-based correct index.",
                    );
                }
                allowedFields = [
                    ...allowedFields,
                    "choices",
                    "correctChoiceIndex",
                ];
                question = {
                    ...base,
                    format: 0,
                    choices: value.choices.map((choice) => choice.trim()),
                    correctChoiceIndex: value.correctChoiceIndex as number,
                };
            } else {
                if (
                    !Number.isSafeInteger(value.maxCharacters) ||
                    (value.maxCharacters as number) <= 0 ||
                    (value.maxCharacters as number) > 4294967295 ||
                    !nonempty(value.answerCriteria)
                ) {
                    throw new Error(
                        "Free-text questions need a positive character limit and grading criteria.",
                    );
                }
                allowedFields = [
                    ...allowedFields,
                    "maxCharacters",
                    "answerCriteria",
                ];
                question = {
                    ...base,
                    format: 1,
                    maxCharacters: value.maxCharacters as number,
                    answerCriteria: value.answerCriteria.trim(),
                };
            }
            if (Object.keys(value).some((key) => !allowedFields.includes(key)))
                throw new Error("Question contains unsupported fields.");
            if (texts.has(normalized(question.text)))
                throw new Error("Question duplicates an existing question.");
            texts.add(normalized(question.text));
            questions.push(question);
        } catch (error) {
            warnings.push(
                error instanceof Error
                    ? error.message
                    : "Invalid question was skipped.",
            );
        }
    }
    if (questions.length < count)
        warnings.push(
            `Only ${questions.length} of ${count} requested questions passed validation.`,
        );
    return { questions, warnings };
}

function emptyUsage(): AiTokenUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
    };
}

/** No UI or credentials in this layer. All provider calls use the shared AI integration. */
export async function runQuestionGeneration(
    request: QuestionGenerationRequest,
    dependencies: GenerationDependencies,
    options: QuestionGenerationOptions = {},
): Promise<QuestionGenerationResult> {
    let note = await dependencies.loadNote(request.noteId);
    validateRequest(request, note);
    const basics = planBasicQuestions(note).filter(
        (task) => task.remainingCount > 0,
    );
    const isBasic =
        options.generationMode !== "additional" && basics.length > 0;
    const tasks = isBasic ? basics : planAdditionalQuestions(note, request);
    const result: QuestionGenerationResult = {
        mode: isBasic ? "basic" : "additional",
        generatedCount: 0,
        requestedCount: tasks.reduce(
            (sum, task) => sum + task.remainingCount,
            0,
        ),
        complete: false,
        note,
        warnings: [],
        usage: emptyUsage(),
    };
    try {
        options.onProgress?.({
            mode: result.mode,
            generatedCount: 0,
            requestedCount: result.requestedCount,
        });
        for (const task of tasks) {
            let remaining = task.remainingCount;
            while (remaining > 0) {
                // Limit output size; each batch gets at most one corrective request.
                const batchCount = Math.min(4, remaining);
                let missing = batchCount;
                let feedback: string | undefined;
                for (let attempt = 0; attempt < 2 && missing > 0; attempt++) {
                    if (options.signal?.aborted)
                        throw new Error(
                            "Question generation was cancelled. Saved batches are preserved.",
                        );
                    const response = await dependencies.promptAi(
                        buildQuestionPrompt(
                            note,
                            task,
                            missing,
                            request.outputLanguage,
                            feedback,
                        ),
                    );
                    for (const key of Object.keys(
                        result.usage,
                    ) as (keyof AiTokenUsage)[])
                        result.usage[key] += response.usage[key];
                    let parsed: ReturnType<typeof parseGeneratedQuestions>;
                    try {
                        parsed = parseGeneratedQuestions(
                            response.text,
                            task,
                            missing,
                            note,
                        );
                    } catch {
                        parsed = {
                            questions: [],
                            warnings: [
                                "The AI response did not contain valid question JSON.",
                            ],
                        };
                    }
                    result.warnings.push(...parsed.warnings);
                    feedback = parsed.warnings.join("\n");
                    if (!parsed.questions.length) continue;
                    // Date fields are serialized explicitly at the persistence boundary.
                    const now = new Date();
                    const card = isBasic ? createEmptyCard(now) : null;
                    note = await dependencies.saveBatch({
                        noteId: note.id,
                        sourceText: note.file.text,
                        sourceTopics: note.topics,
                        expectedQuestionIds: note.questions.map(
                            (question) => question.id,
                        ),
                        isBasicQuestion: isBasic,
                        scope: task.scope,
                        model: response.model,
                        difficulty: task.difficulty,
                        format: task.format,
                        targetCount: task.targetCount,
                        allowedTopicIds: task.topics.map((topic) => topic.id),
                        questions: parsed.questions.map((question) =>
                            isBasic && card
                                ? {
                                      ...question,
                                      fsrsData: {
                                          ...card,
                                          due: now.toISOString(),
                                          last_review: undefined,
                                      },
                                  }
                                : question,
                        ),
                    });
                    missing -= parsed.questions.length;
                    remaining -= parsed.questions.length;
                    result.generatedCount += parsed.questions.length;
                    result.note = note;
                    options.onNoteUpdated?.(note);
                    options.onProgress?.({
                        mode: result.mode,
                        generatedCount: result.generatedCount,
                        requestedCount: result.requestedCount,
                    });
                }
                if (missing) break;
            }
        }
        result.complete = result.generatedCount === result.requestedCount;
        result.warnings = [...new Set(result.warnings)];
        return result;
    } catch (error) {
        const message =
            record(error) && typeof error.message === "string"
                ? error.message
                : typeof error === "string"
                  ? error
                  : "Question generation failed.";
        const details = record(error)
            ? [
                  ["Error code", error.code],
                  ["Provider code", error.providerCode],
                  ["Request ID", error.requestId],
                  ["HTTP status", error.status],
              ]
                  .filter(
                      ([, value]) =>
                          typeof value === "number" ||
                          (typeof value === "string" &&
                              /^[\w.:-]{1,200}$/.test(value)),
                  )
                  .map(([label, value]) => `${label}: ${value}`)
                  .join("\n")
            : "";
        throw new QuestionGenerationError(message, result, details || null);
    }
}
