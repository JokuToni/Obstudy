<script lang="ts">
    import type {
        ExerciseDraftAnswer,
        AnswerGrade,
    } from "$lib/types/exercises";
    import { button, primaryButton } from "$lib/components/ui/styles";
    import StudyText from "./StudyText.svelte";
    let {
        answer,
        busy = false,
        disabled = false,
        error = null,
        onGrade,
        onAi,
    }: {
        answer: ExerciseDraftAnswer;
        busy?: boolean;
        disabled?: boolean;
        error?: string | null;
        onGrade: (grade: AnswerGrade) => void;
        onAi: () => void;
    } = $props();
    const levels = [
        { points: 0, label: "Incorrect" },
        { points: 0.5, label: "Partly correct" },
        { points: 1, label: "Correct" },
    ] as const;
</script>

<section
    aria-label="Grade this answer"
    class="space-y-3 border-t border-border pt-4"
>
    <h3 class="text-sm font-medium">
        {answer.grade
            ? `Grade: ${answer.grade.points} / 1`
            : "Grade your answer"}
    </h3>
    {#if answer.grade}<p class="text-xs text-text-muted">
            {answer.grade.source === "ai"
                ? "Graded by AI"
                : answer.grade.source === "automatic"
                  ? "Automatically graded"
                  : "Self graded"}
        </p>{/if}
    {#if answer.grade?.feedback}<div class="text-sm/6 text-text-secondary">
            <StudyText text={answer.grade.feedback} />
        </div>{/if}
    {#if answer.grade?.source !== "automatic"}
        <div
            class="flex flex-wrap gap-2"
            role="group"
            aria-label="Self grading"
        >
            {#each levels as level}<button
                    type="button"
                    class={answer.grade?.points === level.points &&
                    answer.grade.source === "self"
                        ? primaryButton
                        : button}
                    aria-pressed={answer.grade?.points === level.points &&
                        answer.grade.source === "self"}
                    disabled={disabled || busy}
                    onclick={() =>
                        onGrade({
                            points: level.points,
                            source: "self",
                            feedback: "",
                        })}>{level.label} · {level.points}</button
                >{/each}
            <button
                type="button"
                class={button}
                disabled={disabled || busy}
                onclick={onAi}
                >{busy ? "Grading with AI…" : "Grade with AI"}</button
            >
        </div>
    {/if}
    {#if !answer.grade && !busy}<p class="text-xs/5 text-text-muted">
            You can leave this for the results view.
        </p>{/if}
    {#if error}<p role="alert" class="text-sm/5 text-danger">{error}</p>{/if}
</section>
