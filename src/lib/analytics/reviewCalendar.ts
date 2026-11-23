import { TypeConvert } from "ts-fsrs";
import type { SyncedNote } from "$lib/types/notes";
import { studyQuestionsDueToday } from "$lib/exercises/selection";
import { localDay } from "./overview";

export function reviewCalendar(
    notes: SyncedNote[],
    month: Date,
    now = new Date(),
) {
    const today = localDay(now);
    const counts = new Map<number, number>();
    for (const note of notes) {
        if (
            !note.isStudying ||
            !note.isAvailable ||
            note.parseError ||
            note.syncIssues.length
        )
            continue;
        const basicIds = new Set(
            note.questions
                .filter((question) => question.isBasicQuestion)
                .map((question) => question.id),
        );
        const todayIds = new Set(
            studyQuestionsDueToday(note, now).questions.map(
                (question) => question.id,
            ),
        );
        const seen = new Set<string>();
        for (const stored of note.questionFsrs) {
            if (!basicIds.has(stored.questionId) || seen.has(stored.questionId))
                continue;
            try {
                const card = TypeConvert.card(stored.fsrsData);
                if (!Number.isFinite(card.due.getTime())) continue;
                const dueDay = localDay(card.due);
                if (dueDay <= today && !todayIds.has(stored.questionId))
                    continue;
                // Outstanding work belongs to today rather than a past date.
                const day = Math.max(today, dueDay);
                counts.set(day, (counts.get(day) ?? 0) + 1);
                seen.add(stored.questionId);
            } catch {
                // Invalid schedules are also excluded from Study selection.
            }
        }
    }
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const first = new Date(year, monthIndex, 1);
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const leading = (first.getDay() + 6) % 7;
    const cellCount = Math.ceil((leading + daysInMonth) / 7) * 7;
    const cells = Array.from({ length: cellCount }, (_, index) => {
        const day = index - leading + 1;
        if (day < 1 || day > daysInMonth) return null;
        const date = new Date(year, monthIndex, day);
        return {
            date,
            count: counts.get(localDay(date)) ?? 0,
            isToday: localDay(date) === today,
        };
    });
    const weeks = Array.from({ length: cellCount / 7 }, (_, index) =>
        cells.slice(index * 7, index * 7 + 7),
    );
    return {
        weeks,
        total: cells.reduce((sum, cell) => sum + (cell?.count ?? 0), 0),
    };
}
