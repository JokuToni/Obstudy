import { TypeConvert } from "ts-fsrs";
import type { PracticeSettings, Question, StudyMode } from "../types/index";
import type { SyncedNote } from "../types/notes";
import type { ExerciseSelection } from "../types/exercises";

export const defaultPracticeSettings: PracticeSettings = {
    questionCount: 10,
    difficulty: 0,
    reuseQuestions: true,
    questionFormat: 2,
    topicIds: [],
};

export function validateExerciseSettings(settings: PracticeSettings): void {
    if (
        !Number.isInteger(settings.questionCount) ||
        settings.questionCount < 1 ||
        settings.questionCount > 1000
    )
        throw new Error("Choose between 1 and 1000 questions.");
    if (
        ![0, 1, 2].includes(settings.difficulty) ||
        ![0, 1, 2].includes(settings.questionFormat) ||
        typeof settings.reuseQuestions !== "boolean"
    )
        throw new Error("Invalid practice settings.");
    const levels = selectedDifficulties(settings);
    if (
        !levels.length ||
        levels.some((level) => ![0, 1, 2].includes(level)) ||
        new Set(levels).size !== levels.length
    )
        throw new Error("Select at least one valid difficulty.");
}

/** Legacy saved profiles have only a single difficulty. */
export function selectedDifficulties(settings: PracticeSettings) {
    return [...(settings.difficulties ?? [settings.difficulty])].sort(
        (left, right) => left - right,
    );
}

export function effectiveExerciseSettings(
    settings: PracticeSettings,
    mode: StudyMode,
): PracticeSettings {
    return mode === "study"
        ? {
              ...settings,
              difficulty: 0,
              difficulties: [0],
              questionFormat: 2,
              reuseQuestions: true,
              topicIds: [...settings.topicIds],
          }
        : {
              ...settings,
              difficulty:
                  selectedDifficulties(settings)[0] ?? settings.difficulty,
              difficulties: selectedDifficulties(settings),
              topicIds: [...settings.topicIds],
          };
}

function questionsForTopics(
    note: SyncedNote,
    settings: PracticeSettings,
): Question[] {
    if (settings.excludeAllTopics)
        throw new Error(
            "Include at least one topic before starting a session.",
        );
    const ids = new Set(settings.topicIds);
    if ([...ids].some((id) => !note.topics.some((topic) => topic.id === id)))
        throw new Error(
            "A selected topic no longer belongs to this note. Update practice settings.",
        );
    for (const topic of note.topics)
        if (
            "broadTopicId" in topic &&
            topic.broadTopicId &&
            ids.has(topic.broadTopicId)
        )
            ids.add(topic.id);
    return note.questions.filter(
        (question) => !ids.size || question.topicIds.some((id) => ids.has(id)),
    );
}

export function matchingPracticeQuestions(
    note: SyncedNote,
    settings: PracticeSettings,
): Question[] {
    return questionsForTopics(note, settings).filter(
        (question) =>
            selectedDifficulties(settings).includes(question.difficulty) &&
            (settings.questionFormat === 2 ||
                question.format === settings.questionFormat),
    );
}

/** luoHarjoitus selection: study filters topics in due order; practice follows the filters. */
export function selectExerciseQuestions(
    note: SyncedNote,
    settings: PracticeSettings,
    mode: StudyMode,
    now = new Date(),
    random = Math.random,
): ExerciseSelection {
    validateExerciseSettings(effectiveExerciseSettings(settings, mode));
    if (!note.isAvailable || note.parseError || note.syncIssues.length)
        throw new Error(
            "Resolve note errors and pending topic changes before starting a session.",
        );
    const nextDay = new Date(now);
    nextDay.setHours(24, 0, 0, 0);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    if (!Number.isFinite(nextDay.getTime()))
        throw new Error("Invalid session date.");
    const warnings: string[] = [];
    let questions: Question[];
    if (mode === "study") {
        const submittedToday = new Set(
            note.answers
                .filter((answer) => {
                    const submittedAt = new Date(answer.answeredAt).getTime();
                    return (
                        answer.mode === "study" &&
                        !note.fsrsReviewedAnswerIds?.includes(answer.id) &&
                        submittedAt >= dayStart.getTime() &&
                        submittedAt < nextDay.getTime()
                    );
                })
                .map((answer) => answer.questionId),
        );
        const due = new Map<string, number>();
        for (const stored of note.questionFsrs) {
            try {
                const card = TypeConvert.card(stored.fsrsData);
                if (!Number.isFinite(card.due.getTime()))
                    throw new Error("Invalid due date");
                if (
                    card.state === 1 || card.state === 3
                        ? card.due.getTime() <= now.getTime()
                        : card.due.getTime() < nextDay.getTime()
                )
                    due.set(stored.questionId, card.due.getTime());
            } catch {
                warnings.push(
                    "Some study cards have invalid schedule data and were skipped. Reset their study schedule to recreate them.",
                );
            }
        }
        questions = questionsForTopics(note, settings)
            .filter(
                (question) =>
                    question.isBasicQuestion &&
                    due.has(question.id) &&
                    !submittedToday.has(question.id),
            )
            .sort(
                (left, right) =>
                    due.get(left.id)! - due.get(right.id)! ||
                    left.id.localeCompare(right.id),
            );
    } else {
        questions = [...matchingPracticeQuestions(note, settings)];
        for (let index = questions.length - 1; index > 0; index--) {
            const target = Math.floor(random() * (index + 1));
            [questions[index], questions[target]] = [
                questions[target],
                questions[index],
            ];
        }
        const lastAnswered = new Map<string, number>();
        for (const question of questions) {
            const timestamp = question.lastAnsweredAt
                ? Date.parse(question.lastAnsweredAt)
                : NaN;
            if (Number.isFinite(timestamp))
                lastAnswered.set(question.id, timestamp);
        }
        for (const answer of note.answers) {
            const timestamp = Date.parse(answer.answeredAt);
            if (Number.isFinite(timestamp))
                lastAnswered.set(
                    answer.questionId,
                    Math.max(
                        lastAnswered.get(answer.questionId) ?? -Infinity,
                        timestamp,
                    ),
                );
        }
        // Shuffle ties, then prioritize unseen questions and the oldest submissions.
        questions.sort((left, right) =>
            (lastAnswered.get(left.id) ?? -Infinity) ===
            (lastAnswered.get(right.id) ?? -Infinity)
                ? 0
                : (lastAnswered.get(left.id) ?? -Infinity) <
                    (lastAnswered.get(right.id) ?? -Infinity)
                  ? -1
                  : 1,
        );
    }
    if (!questions.length)
        throw new Error(
            mode === "study"
                ? "No Study cards are ready in the selected topics. Learning cards return at their scheduled time; choose Practice to use your question bank."
                : "No saved questions match these practice settings. Change the filters or turn off Reuse questions to generate fresh questions.",
        );
    const selected = questions.slice(0, settings.questionCount);
    if (selected.length < settings.questionCount)
        warnings.push(
            mode === "study"
                ? `Only ${selected.length} basic questions are due today in the selected topics. No new questions were generated.`
                : `Only ${selected.length} saved questions match your settings. This session uses those questions.`,
        );
    return {
        questionIds: selected.map((question) => question.id),
        dueBefore: nextDay.toISOString(),
        dueAfter: dayStart.toISOString(),
        dueNow: now.toISOString(),
        warnings: [...new Set(warnings)],
    };
}
