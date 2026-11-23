import { expect, test } from "@playwright/test";
import { reviewCalendar } from "../../src/lib/analytics/reviewCalendar";
import { studyQuestionsDueToday } from "../../src/lib/exercises/selection";
import { practiceNote } from "../fixtures/practice";

test("calendar renders complete Monday-first months, including leap years and six-week months", () => {
    for (const [year, month, days, weeks, leading] of [
        [2027, 1, 28, 4, 0],
        [2028, 1, 29, 5, 1],
        [2026, 2, 31, 6, 6],
        [2026, 11, 31, 5, 1],
        [2027, 0, 31, 5, 4],
    ]) {
        const calendar = reviewCalendar([], new Date(year, month, 1));
        expect(calendar.weeks).toHaveLength(weeks);
        expect(calendar.weeks.every((week) => week.length === 7)).toBe(true);
        const cells = calendar.weeks.flat();
        expect(cells.findIndex((cell) => cell !== null)).toBe(leading);
        expect(
            cells
                .filter((cell) => cell !== null)
                .map((cell) => cell.date.getDate()),
        ).toEqual(Array.from({ length: days }, (_, index) => index + 1));
        expect(calendar.total).toBe(0);
    }
});

test("calendar groups current schedules by local date and rolls overdue cards into today", () => {
    const now = new Date(2026, 9, 25, 12);
    const note = practiceNote(now);
    note.questionFsrs[1].fsrsData.state = 1;
    const month = reviewCalendar([note], now, now);
    const count = (day: number) =>
        month.weeks.flat().find((cell) => cell?.date.getDate() === day)?.count;
    expect(count(24)).toBe(0);
    expect(count(25)).toBe(studyQuestionsDueToday(note, now).questions.length);
    expect(count(25)).toBe(2);
    expect(count(26)).toBe(1);
    expect(month.total).toBe(3);
    expect(month.weeks.flat().filter((cell) => cell?.isToday)).toHaveLength(1);
    note.questionFsrs[0].fsrsData.due = new Date(2026, 10, 1).toISOString();
    expect(reviewCalendar([note], now, now).total).toBe(2);
    expect(reviewCalendar([note], new Date(2026, 10, 1), now).total).toBe(1);
});

test("calendar excludes inactive, unavailable, unresolved, invalid, additional, and duplicate cards", () => {
    const now = new Date(2026, 9, 25, 12);
    const note = practiceNote(now);
    note.questionFsrs.push(structuredClone(note.questionFsrs[0]));
    note.questionFsrs[3].fsrsData.due = "invalid";
    const paused = { ...practiceNote(now), id: "paused", isStudying: false };
    const missing = { ...practiceNote(now), id: "missing", isAvailable: false };
    const unresolved = {
        ...practiceNote(now),
        id: "unresolved",
        parseError: "Invalid note",
    };
    expect(
        reviewCalendar([note, paused, missing, unresolved], now, now).total,
    ).toBe(2);
    note.answers = [
        {
            id: "legacy",
            questionId: "q0",
            mode: "study",
            points: 1,
            answeredAt: now.toISOString(),
            text: "Answer",
            feedback: "",
        },
    ];
    expect(reviewCalendar([note], now, now).total).toBe(1);
    note.fsrsReviewedAnswerIds = ["legacy"];
    expect(reviewCalendar([note], now, now).total).toBe(2);
});

test("local midnight and DST transitions preserve daily counts and rescheduled dates", () => {
    for (const [month, day] of [
        [2, 28],
        [9, 24],
    ]) {
        const now = new Date(2026, month, day, 12);
        const note = practiceNote(now);
        note.questionFsrs[0].fsrsData.due = new Date(
            2026,
            month,
            day + 1,
            0,
            1,
        ).toISOString();
        note.questionFsrs[1].fsrsData.due = new Date(
            2026,
            month,
            day + 2,
            0,
            1,
        ).toISOString();
        note.questionFsrs[3].fsrsData.due = new Date(
            2026,
            month + 1,
            1,
        ).toISOString();
        const cells = reviewCalendar([note], now, now).weeks.flat();
        expect(cells.find((cell) => cell?.date.getDate() === day)?.count).toBe(
            0,
        );
        expect(
            cells.find((cell) => cell?.date.getDate() === day + 1)?.count,
        ).toBe(1);
        expect(
            cells.find((cell) => cell?.date.getDate() === day + 2)?.count,
        ).toBe(1);
        const tomorrow = new Date(2026, month, day + 1, 12);
        const next = reviewCalendar([note], now, tomorrow).weeks.flat();
        expect(next.find((cell) => cell?.isToday)?.count).toBe(1);
    }
});
