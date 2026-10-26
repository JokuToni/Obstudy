<script lang="ts">
    import type {
        ExerciseDraftAnswer,
        ExerciseSession,
        AnswerGrade,
    } from "$lib/types/exercises";
    import StudyText from "$lib/components/practice/StudyText.svelte";
    import AnswerGrading from "$lib/components/practice/AnswerGrading.svelte";
    import { button, primaryButton } from "$lib/components/ui/styles";
    let {
        session,
        answers,
        onClose,
        onReview,
        grading,
        gradingErrors,
        onGrade,
        onAiGrade,
    }: {
        session: ExerciseSession;
        answers: ExerciseDraftAnswer[];
        onClose: () => void;
        onReview: (index: number) => void;
        grading: Record<string, boolean>;
        gradingErrors: Record<string, string | null>;
        onGrade: (questionId: string, grade: AnswerGrade) => void;
        onAiGrade: (questionId: string) => Promise<void>;
    } = $props();
    const graded = $derived(answers.filter((answer) => answer.grade));
    const points = $derived(
        graded.reduce((sum, answer) => sum + (answer.grade?.points ?? 0), 0),
    );
    const pending = $derived(
        answers.filter((answer) => answer.revealed && !answer.grade).length,
    );
</script>

<div class="mx-auto w-full max-w-3xl space-y-8 py-6">
    <div class="space-y-2">
        <p class="text-[13px]/5 text-accent">
            {session.closedAt
                ? "Session saved"
                : pending
                  ? "Grading pending"
                  : "Session results"}
        </p>
        <h2 class="text-[22px]/[30px] font-semibold">Review your answers</h2>
        <p class="text-sm/5 text-text-secondary">
            {graded.length} graded answers · {points} / {graded.length} points.
            {pending
                ? `${pending} ${pending === 1 ? "answer still needs" : "answers still need"} a grade.`
                : "All submitted answers are graded."}
        </p>
    </div>
    <div class="space-y-6">
        {#each session.questions as question, index (question.id)}
            {@const answer = answers.find(
                (item) => item.questionId === question.id,
            )}
            <section
                class="space-y-4 border-t border-border pt-6"
                aria-label={`Question ${index + 1} review`}
            >
                <div class="flex items-center justify-between gap-3">
                    <h3 class="text-[13px]/5 font-medium text-text-secondary">
                        Question {index + 1}
                    </h3>
                    <button
                        type="button"
                        class={button}
                        onclick={() => onReview(index)}>View question</button
                    >
                </div>
                <div class="text-base/7">
                    <StudyText text={question.text} />
                </div>
                <div class="space-y-2">
                    <h4 class="text-[13px]/5 font-medium text-text-secondary">
                        Your answer
                    </h4>
                    <div
                        class="rounded-md border border-border bg-surface p-4 text-sm/6"
                    >
                        <StudyText
                            text={answer?.text ?? "No answer"}
                            standaloneMath={question.format === 0}
                        />
                    </div>
                    {#if answer?.revealed}<AnswerGrading
                            {answer}
                            busy={grading[question.id]}
                            error={gradingErrors[question.id]}
                            disabled={!!session.closedAt}
                            onGrade={(grade) => onGrade(question.id, grade)}
                            onAi={() => {
                                void onAiGrade(question.id);
                            }}
                        />
                    {:else}<p class="text-xs/5 text-text-muted">
                            {answer?.text
                                ? "Unsubmitted draft. Return to the question to submit and grade it."
                                : "No answer submitted."}
                        </p>{/if}
                </div>
                {#if answer?.revealed}<div class="space-y-2">
                        <h4
                            class="text-[13px]/5 font-medium text-text-secondary"
                        >
                            Example answer
                        </h4>
                        <div class="text-sm/6">
                            <StudyText text={question.exampleAnswer} />
                        </div>
                    </div>{/if}
            </section>
        {/each}
    </div>
    <div class="border-t border-border pt-6">
        <button type="button" class={primaryButton} onclick={onClose}
            >Close session</button
        >
    </div>
</div>
