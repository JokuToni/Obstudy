import { expect, test } from "@playwright/test";
import {
    effectiveExerciseSettings,
    selectExerciseQuestions,
} from "../../src/lib/exercises/selection";
import { practiceNote } from "../fixtures/practice";

test("study selects only due basic cards in order through the end of the local day and ignores practice filters", () => {
    const now = new Date(2026, 9, 25, 12);
    const note = practiceNote(now);
    const before = structuredClone(note);
    const settings = {
        questionCount: 10,
        difficulty: 2 as const,
        reuseQuestions: false,
        questionFormat: 1 as const,
        topicIds: ["foreign"],
    };
    const result = selectExerciseQuestions(note, settings, "study", now);
    expect(result.questionIds).toEqual(["q0", "q1"]);
    expect(result.dueBefore).toBe(new Date(2026, 9, 26).toISOString());
    expect(result.warnings.join(" ")).toContain(
        "No new questions were generated",
    );
    expect(note).toEqual(before);
    expect(effectiveExerciseSettings(settings, "study")).toMatchObject({
        questionCount: 10,
        difficulty: 0,
        reuseQuestions: true,
        questionFormat: 2,
        topicIds: [],
    });
});

test("study respects the limit and gives an actionable empty state without generating questions", () => {
    const now = new Date(2026, 9, 25, 12);
    const note = practiceNote(now);
    expect(
        selectExerciseQuestions(
            note,
            { ...note.savedPracticeSettings!, questionCount: 1 },
            "study",
            now,
        ).questionIds,
    ).toEqual(["q0"]);
    note.questionFsrs = [];
    expect(() =>
        selectExerciseQuestions(
            note,
            note.savedPracticeSettings!,
            "study",
            now,
        ),
    ).toThrow("No basic questions are due today");
});

test("practice applies difficulty, format, and selected broad topics and includes additional questions", () => {
    const note = practiceNote();
    const settings = {
        ...note.savedPracticeSettings!,
        topicIds: ["broad"],
        questionFormat: 1 as const,
    };
    expect(
        selectExerciseQuestions(note, settings, "practice").questionIds,
    ).toEqual(["q2"]);
    expect(
        selectExerciseQuestions(note, settings, "practice").warnings.join(" "),
    ).toContain("Only 1 saved questions");
    expect(() =>
        selectExerciseQuestions(
            note,
            { ...settings, topicIds: ["foreign"] },
            "practice",
        ),
    ).toThrow("no longer belongs");
});

test("Practice prioritizes unseen questions, then the least recently submitted questions", () => {
    const note = practiceNote();
    note.questions.find((question) => question.id === "q0")!.lastAnsweredAt =
        "2026-10-25T12:00:00Z";
    note.questions.find((question) => question.id === "q2")!.lastAnsweredAt =
        "2026-10-24T12:00:00Z";
    expect(
        selectExerciseQuestions(
            note,
            { ...note.savedPracticeSettings!, questionCount: 3 },
            "practice",
        ).questionIds,
    ).toEqual(["q3", "q2", "q0"]);
});

test("Study skips same-day study submissions, honors local day boundaries, and does not skip Practice answers", () => {
    const now = new Date(2026, 9, 25, 12);
    const note = practiceNote(now);
    note.answers = [
        {
            id: "answer",
            questionId: "q0",
            text: "Submitted",
            points: null,
            feedback: "",
            mode: "study",
            answeredAt: new Date(2026, 9, 25, 0).toISOString(),
        },
    ];
    expect(
        selectExerciseQuestions(note, note.savedPracticeSettings!, "study", now)
            .questionIds,
    ).toEqual(["q1"]);
    note.answers[0].mode = "practice";
    expect(
        selectExerciseQuestions(note, note.savedPracticeSettings!, "study", now)
            .questionIds,
    ).toEqual(["q0", "q1"]);
    note.answers[0].mode = "study";
    note.answers[0].answeredAt = new Date(2026, 9, 24, 23, 59).toISOString();
    expect(
        selectExerciseQuestions(note, note.savedPracticeSettings!, "study", now)
            .questionIds,
    ).toEqual(["q0", "q1"]);
    expect(
        selectExerciseQuestions(note, note.savedPracticeSettings!, "study", now)
            .dueAfter,
    ).toBe(new Date(2026, 9, 25).toISOString());
});

test("Practice accepts multiple difficulty filters while Study ignores them", () => {
    const now = new Date(2026, 9, 25, 12);
    const note = practiceNote(now);
    note.questions.find((question) => question.id === "q2")!.difficulty = 1;
    const settings = {
        ...note.savedPracticeSettings!,
        difficulties: [1, 2] as (0 | 1 | 2)[],
    };
    expect(
        selectExerciseQuestions(
            note,
            settings,
            "practice",
            now,
        ).questionIds.sort(),
    ).toEqual(["q1", "q2"]);
    expect(
        selectExerciseQuestions(note, settings, "study", now).questionIds,
    ).toEqual(["q0", "q1"]);
    expect(() =>
        selectExerciseQuestions(
            note,
            { ...settings, difficulties: [] },
            "practice",
            now,
        ),
    ).toThrow("Select at least one");
});

test("selection rejects unresolved notes and invalid counts before session persistence", () => {
    const note = practiceNote();
    expect(() =>
        selectExerciseQuestions(
            note,
            { ...note.savedPracticeSettings!, questionCount: 0 },
            "study",
        ),
    ).toThrow("between 1 and 1000");
    note.parseError = "Invalid note";
    expect(() =>
        selectExerciseQuestions(note, note.savedPracticeSettings!, "study"),
    ).toThrow("Resolve note errors");
});

test("an explicit empty topic selection blocks Practice while Study still ignores topic filters", () => {
    const note = practiceNote();
    const settings = {
        ...note.savedPracticeSettings!,
        topicIds: [],
        excludeAllTopics: true,
    };
    expect(() => selectExerciseQuestions(note, settings, "practice")).toThrow(
        "Include at least one topic",
    );
    expect(effectiveExerciseSettings(settings, "study").excludeAllTopics).toBe(
        false,
    );
});
