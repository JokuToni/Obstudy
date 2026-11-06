import { expect, test } from "@playwright/test";
import { createEmptyCard, State } from "ts-fsrs";
import {
    scheduleReview,
    type StudyReviewContext,
} from "../../src/lib/fsrs/scheduler";
import { letterGrade, topicProgress } from "../../src/lib/analytics/topics";
import { practiceNote } from "../fixtures/practice";

function context(rating: 1 | 2 | 3 | 4): StudyReviewContext {
    const now = new Date("2026-11-06T12:00:00Z");
    return {
        questionId: "q0",
        beforeCard: JSON.parse(JSON.stringify(createEmptyCard(now))),
        reviewedAt: now.toISOString(),
        rating,
        points: 1,
    };
}

test("all four FSRS ratings update memory state and produce serialized review logs", () => {
    for (const rating of [1, 2, 3, 4] as const) {
        const initial = context(rating);
        const next = scheduleReview(initial);
        expect(next.beforeCard).toEqual(initial.beforeCard);
        expect(next.afterCard.reps).toBe(1);
        expect(next.afterCard.last_review).toBe(initial.reviewedAt);
        expect(Date.parse(next.afterCard.due)).toBeGreaterThan(
            Date.parse(initial.reviewedAt),
        );
        expect(next.afterCard.stability).toBeGreaterThan(0);
        expect(next.afterCard.difficulty).toBeGreaterThanOrEqual(1);
        expect(next.reviewLog.rating).toBe(rating);
        expect(next.reviewLog.review).toBe(initial.reviewedAt);
        expect(next.afterCard.state).toBe(
            rating === 4 ? State.Review : State.Learning,
        );
    }
});

test("later successful reviews extend intervals while forgetting starts relearning", () => {
    const first = scheduleReview(context(4));
    const nextContext = {
        ...context(3),
        beforeCard: first.afterCard,
        reviewedAt: first.afterCard.due,
    };
    const good = scheduleReview(nextContext);
    const again = scheduleReview({ ...nextContext, rating: 1 });
    expect(good.afterCard.reps).toBe(2);
    expect(good.afterCard.scheduled_days).toBeGreaterThan(
        first.afterCard.scheduled_days,
    );
    expect(again.afterCard.state).toBe(State.Relearning);
    expect(again.afterCard.lapses).toBe(1);
    expect(
        Date.parse(again.afterCard.due) - Date.parse(nextContext.reviewedAt),
    ).toBeLessThan(86400000);
});

test("letter grades use exact percentage thresholds without rounding up", () => {
    expect(letterGrade(null)).toBe("—");
    expect(letterGrade(0.97)).toBe("A+");
    expect(letterGrade(0.969)).toBe("A");
    expect(letterGrade(0.9)).toBe("A−");
    expect(letterGrade(0.87)).toBe("B+");
    expect(letterGrade(0.83)).toBe("B");
    expect(letterGrade(0.6)).toBe("D−");
    expect(letterGrade(0.599)).toBe("F");
});

test("topic analytics count cards once and average only the latest 50 graded answers", () => {
    const note = practiceNote(new Date("2026-11-06T12:00:00Z"));
    note.answers = Array.from({ length: 55 }, (_, index) => ({
        id: String(index),
        questionId: "q0",
        answeredAt: new Date(2026, 10, index + 1).toISOString(),
        text: "answer",
        feedback: "",
        points: index < 5 ? 0 : 1,
    }));
    note.answers.push({
        id: "ungraded",
        questionId: "q0",
        answeredAt: "2027-01-01T00:00:00Z",
        text: "pending",
        feedback: "",
        points: null,
    });
    const topic = topicProgress(note)[0];
    expect(topic.count).toBe(50);
    expect(topic.average).toBe(1);
    expect(topic.grade).toBe("A+");
    expect(topic.total).toBe(2);
    note.answers = note.answers.slice(0, 2);
    expect(topicProgress(note)[0].count).toBe(2);
    expect(topicProgress(note)[0].average).toBe(0);
    expect(topicProgress(note)[1].grade).toBe("—");
});
