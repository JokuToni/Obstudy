import { expect, test } from "@playwright/test";
import { automaticGrade, parseAiGrade } from "../../src/lib/grading/answers";
import { practiceSession } from "../fixtures/practice";

test("multiple choice is binary and has no grade before submission", () => {
    const question = practiceSession().questions[0];
    const answer = {
        questionId: question.id,
        text: "choice",
        selectedChoiceIndex: 0,
        revealed: false,
    };
    expect(automaticGrade(question, answer)).toBeNull();
    expect(
        automaticGrade(question, { ...answer, revealed: true })?.points,
    ).toBe(1);
    expect(
        automaticGrade(question, {
            ...answer,
            selectedChoiceIndex: 1,
            revealed: true,
        })?.points,
    ).toBe(0);
});

test("AI grades accept the agreed scale and retain feedback and provenance", () => {
    expect(
        parseAiGrade(
            '```json\n{"points":0.5,"feedback":"Missing the endpoint."}\n```',
            "test-model",
        ),
    ).toEqual({
        points: 0.5,
        feedback: "Missing the endpoint.",
        source: "ai",
        model: "test-model",
    });
    for (const points of [0, 1])
        expect(
            parseAiGrade(
                JSON.stringify({ points, feedback: "Explanation" }),
                "test-model",
            ).points,
        ).toBe(points);
});

test("invalid AI scores and missing feedback do not become grades", () => {
    for (const text of [
        '{"points":0.7,"feedback":"No"}',
        '{"points":"1","feedback":"No"}',
        '{"points":1,"feedback":""}',
        "null",
        "not JSON",
    ])
        expect(() => parseAiGrade(text, "test-model")).toThrow("invalid grade");
});
