import type { SyncedNote } from "$lib/types/notes";

const gradeThresholds = [
    [97, "A+"],
    [93, "A"],
    [90, "A−"],
    [87, "B+"],
    [83, "B"],
    [80, "B−"],
    [77, "C+"],
    [73, "C"],
    [70, "C−"],
    [67, "D+"],
    [63, "D"],
    [60, "D−"],
    [0, "F"],
] as const;

export function letterGrade(average: number | null): string {
    if (average === null || !Number.isFinite(average)) return "—";
    return (
        gradeThresholds.find(
            ([threshold]) => average * 100 + 1e-8 >= threshold,
        )?.[1] ?? "F"
    );
}

export function topicProgress(note: SyncedNote, now = new Date()) {
    const dayEnd = new Date(now);
    dayEnd.setHours(24, 0, 0, 0);
    return note.topics
        .filter((topic) => !("text" in topic))
        .map((topic) => {
            const ids = new Set([
                topic.id,
                ...note.topics
                    .filter(
                        (child) =>
                            "broadTopicId" in child &&
                            child.broadTopicId === topic.id,
                    )
                    .map((child) => child.id),
            ]);
            const questionIds = new Set(
                note.questions
                    .filter((question) =>
                        question.topicIds.some((id) => ids.has(id)),
                    )
                    .map((question) => question.id),
            );
            const basicIds = new Set(
                note.questions
                    .filter(
                        (question) =>
                            question.isBasicQuestion &&
                            questionIds.has(question.id),
                    )
                    .map((question) => question.id),
            );
            const dates = note.questionFsrs
                .filter((card) => basicIds.has(card.questionId))
                .map((card) => new Date(card.fsrsData.due))
                .filter((date) => Number.isFinite(date.getTime()))
                .sort((a, b) => a.getTime() - b.getTime());
            const days = new Map<string, { date: Date; count: number }>();
            for (const date of dates) {
                const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
                const existing = days.get(key);
                if (existing) existing.count++;
                else days.set(key, { date, count: 1 });
            }
            const saved = note.topicGrades?.find(
                (grade) => grade.topicId === topic.id,
            );
            // Browser fixtures and older IPC responses can derive from active questions.
            const recent = note.answers
                .filter(
                    (answer) =>
                        answer.points !== null &&
                        questionIds.has(answer.questionId),
                )
                .sort(
                    (a, b) =>
                        Date.parse(b.answeredAt) - Date.parse(a.answeredAt) ||
                        b.id.localeCompare(a.id),
                )
                .slice(0, 50);
            const count = saved?.answerCount ?? recent.length;
            const average = saved
                ? saved.averagePoints
                : recent.length
                  ? recent.reduce((sum, answer) => sum + answer.points!, 0) /
                    recent.length
                  : null;
            return {
                ...topic,
                count,
                average,
                grade: letterGrade(average),
                total: dates.length,
                dueToday: dates.filter((date) => date < dayEnd).length,
                next: dates[0] ?? null,
                days: [...days.values()],
            };
        });
}
