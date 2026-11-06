import { expect, test } from "@playwright/test";
import { studyActivity, localDay } from "../../src/lib/analytics/overview";
import {
    readyStudyQuestions,
    selectExerciseQuestions,
} from "../../src/lib/exercises/selection";
import { practiceNote } from "../fixtures/practice";
import type { Answer } from "../../src/lib/types";

function answer(
    id: string,
    date: Date,
    points: number | null = 1,
    mode: "study" | "practice" = "study",
): Answer {
    return {
        id,
        questionId: "q0",
        answeredAt: date.toISOString(),
        text: "Answer",
        points,
        mode,
        feedback: "",
    };
}

test("streaks combine graded answers from both modes, including incorrect answers", () => {
    const note = practiceNote();
    const now = new Date(2026, 10, 6, 12);
    note.answers = [
        answer("one", new Date(2026, 10, 4, 12), 1, "practice"),
        answer("two", new Date(2026, 10, 5, 12), 0),
        answer("three", new Date(2026, 10, 6, 1), 0.5, "practice"),
        answer("four", new Date(2026, 10, 6, 2)),
    ];
    const result = studyActivity([note], now);
    expect(result.current).toBe(3);
    expect(result.longest).toBe(3);
    expect(result.todayCount).toBe(2);
    expect(result.recentCount).toBe(4);
});

test("a streak stays active through yesterday, expires after a missed day, and retains the longest run", () => {
    const note = practiceNote();
    note.answers = [1, 2, 3, 4, 8, 9].map((day) =>
        answer(String(day), new Date(2026, 10, day, 12)),
    );
    expect(studyActivity([note], new Date(2026, 10, 10, 12))).toMatchObject({
        current: 2,
        longest: 4,
        todayCount: 0,
    });
    expect(studyActivity([note], new Date(2026, 10, 11, 12))).toMatchObject({
        current: 0,
        longest: 4,
    });
});

test("ungraded, invalid, future, and duplicate answers do not inflate activity", () => {
    const note = practiceNote();
    const now = new Date(2026, 10, 6, 12);
    note.answers = [
        answer("valid", new Date(2026, 10, 6, 1)),
        answer("draft", new Date(2026, 10, 5, 1), null),
        answer("future", new Date(2026, 10, 7, 1)),
        { ...answer("bad", now), answeredAt: "invalid" },
    ];
    const archived = {
        ...note,
        id: "archived",
        isStudying: false,
        isAvailable: false,
    };
    expect(studyActivity([note, archived], now)).toMatchObject({
        current: 1,
        longest: 1,
        todayCount: 1,
        total: 1,
    });
    expect(studyActivity([], now)).toMatchObject({
        current: 0,
        longest: 0,
        total: 0,
    });
});

test("local calendar streaks remain consecutive across daylight saving boundaries and midnight", () => {
    const note = practiceNote();
    for (const [month, start] of [
        [2, 28],
        [9, 24],
    ]) {
        note.answers = [0, 1, 2].map((offset) =>
            answer(
                String(offset),
                new Date(2026, month, start + offset, 0, 30),
            ),
        );
        const now = new Date(2026, month, start + 2, 12);
        expect(studyActivity([note], now).current).toBe(3);
        expect(
            localDay(new Date(2026, month, start + 1)) -
                localDay(new Date(2026, month, start)),
        ).toBe(1);
    }
});

test("ready counts share Study eligibility and ignore per-session topic and count limits", () => {
    const now = new Date(2026, 9, 25, 12);
    const note = practiceNote(now);
    note.savedPracticeSettings = {
        ...note.savedPracticeSettings!,
        questionCount: 1,
        topicIds: ["other"],
    };
    expect(
        readyStudyQuestions(note, now).questions.map((question) => question.id),
    ).toEqual(["q0", "q1"]);
    const actual = selectExerciseQuestions(
        note,
        { ...note.savedPracticeSettings, questionCount: 1000, topicIds: [] },
        "study",
        now,
    );
    expect(
        readyStudyQuestions(note, now).questions.map((question) => question.id),
    ).toEqual(actual.questionIds);
    note.questionFsrs[0].fsrsData.state = 1;
    note.questionFsrs[0].fsrsData.due = new Date(
        now.getTime() + 60000,
    ).toISOString();
    expect(
        readyStudyQuestions(note, now).questions.map((question) => question.id),
    ).toEqual(["q1"]);
    expect(
        readyStudyQuestions(
            note,
            new Date(now.getTime() + 60000),
        ).questions.map((question) => question.id),
    ).toContain("q0");
    note.parseError = "Invalid note";
    expect(readyStudyQuestions(note, now).questions).toEqual([]);
});
