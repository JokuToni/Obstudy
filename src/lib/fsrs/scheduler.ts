import { fsrs, TypeConvert, type Grade } from "ts-fsrs";
import type { QuestionFsrs } from "$lib/types";

export interface StudyReviewContext {
    questionId: string;
    beforeCard: QuestionFsrs["fsrsData"];
    reviewedAt: string;
    rating: 1 | 2 | 3 | 4;
    points: number;
}

const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });

export function scheduleReview(context: StudyReviewContext) {
    const record = scheduler.next(
        TypeConvert.card(context.beforeCard),
        new Date(context.reviewedAt),
        context.rating as Grade,
    );
    return JSON.parse(
        JSON.stringify({
            ...context,
            points: undefined,
            afterCard: record.card,
            reviewLog: record.log,
        }),
    );
}
