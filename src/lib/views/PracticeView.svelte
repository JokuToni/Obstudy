<script lang="ts">
    import { onMount, tick } from "svelte";
    import type {
        ExerciseDraftAnswer,
        ExerciseSession,
        AnswerGrade,
    } from "$lib/types/exercises";
    import StudyText from "$lib/components/practice/StudyText.svelte";
    import ResultsView from "./ResultsView.svelte";
    import AnswerGrading from "$lib/components/practice/AnswerGrading.svelte";
    import {
        button,
        focusRing,
        input,
        primaryButton,
    } from "$lib/components/ui/styles";

    let {
        session,
        answers,
        saving,
        closing,
        errorMessage,
        onChange,
        onFinish,
        onClose,
        onRetrySave,
        reviewRequest,
        grading,
        gradingErrors,
        onGrade,
        onAiGrade,
    }: {
        session: ExerciseSession;
        answers: ExerciseDraftAnswer[];
        saving: boolean;
        closing: boolean;
        errorMessage: string | null;
        onChange: (answer: ExerciseDraftAnswer) => void;
        onFinish: () => Promise<void>;
        onClose: () => Promise<void>;
        onRetrySave: () => Promise<void>;
        reviewRequest: number;
        grading: Record<string, boolean>;
        gradingErrors: Record<string, string | null>;
        onGrade: (questionId: string, grade: AnswerGrade) => void;
        onAiGrade: (questionId: string) => Promise<void>;
    } = $props();
    let questionIndex = $state(0);
    let materialIndex = $state(0);
    let imageFailed = $state(false);
    let viewingQuestion = $state(false);
    let questionHeading = $state<HTMLHeadingElement>();
    const question = $derived(session.questions[questionIndex]);
    const draft = $derived(
        answers.find((answer) => answer.questionId === question?.id) ?? {
            questionId: question?.id ?? "",
            text: "",
            selectedChoiceIndex: null,
            revealed: false,
        },
    );
    const material = $derived(question?.materials[materialIndex]);
    const submittedCount = $derived(
        answers.filter((answer) => answer.revealed).length,
    );
    const showReview = $derived(
        (!!session.reviewedAt || reviewRequest > 0 || !!session.closedAt) &&
            !viewingQuestion,
    );
    $effect(() => {
        reviewRequest;
        viewingQuestion = false;
    });
    const canReveal = $derived(
        question?.format === 0
            ? draft.selectedChoiceIndex !== null
            : draft.text.trim().length > 0,
    );
    onMount(() => {
        const firstUnanswered = session.questions.findIndex(
            (question) =>
                !answers.some(
                    (answer) =>
                        answer.questionId === question.id && answer.revealed,
                ),
        );
        questionIndex = Math.max(0, firstUnanswered);
    });
    $effect(() => {
        question?.id;
        materialIndex = 0;
    });
    $effect(() => {
        material;
        imageFailed = false;
    });
    async function navigate(index: number): Promise<void> {
        questionIndex = index;
        await tick();
        questionHeading?.focus();
    }
    function changeText(text: string): void {
        onChange({ ...draft, text });
    }
    function selectChoice(index: number): void {
        if (question.format === 0)
            onChange({
                ...draft,
                text: question.choices[index],
                selectedChoiceIndex: index,
            });
    }
    function reveal(): void {
        if (canReveal && !draft.revealed)
            onChange({ ...draft, revealed: true });
    }
</script>

<section
    class="flex h-dvh min-h-0 flex-col bg-canvas text-text-primary"
    aria-label="Practice session"
>
    <header
        class="shrink-0 border-b border-border bg-sidebar px-4 py-4 sm:px-6"
    >
        <div class="mx-auto flex max-w-3xl items-center gap-3">
            <div class="min-w-0 flex-1">
                <p class="text-xs/4 text-text-muted">
                    {session.mode === "study"
                        ? "Study session"
                        : "Practice session"}
                </p>
                <h1
                    class="mt-1 truncate text-base/6 font-semibold"
                    title={session.noteTitle}
                >
                    {session.noteTitle}
                </h1>
            </div>
            <span role="status" class="text-xs/4 text-text-muted"
                >{saving
                    ? "Saving…"
                    : errorMessage
                      ? "Not saved"
                      : "Saved"}</span
            >
            <button
                type="button"
                class={button}
                disabled={closing}
                onclick={onClose}
                >{closing ? "Saving and exiting…" : "Save and exit"}</button
            >
        </div>
    </header>
    <main inert={closing} class="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        {#if errorMessage}<div
                role="alert"
                class="mx-auto mt-4 flex max-w-3xl flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3 text-sm/5 text-danger"
            >
                <p class="min-w-0 flex-1 break-words">{errorMessage}</p>
                <button type="button" class={button} onclick={onRetrySave}
                    >Retry save</button
                >
            </div>{/if}
        {#if showReview}<ResultsView
                {session}
                {answers}
                {onClose}
                {grading}
                {gradingErrors}
                {onGrade}
                {onAiGrade}
                onReview={(index) => {
                    viewingQuestion = true;
                    void navigate(index);
                }}
            />
        {:else if question}
            <div class="mx-auto w-full max-w-3xl space-y-6 py-6">
                {#if session.warnings.length}<details
                        class="rounded-md border border-border bg-surface px-3 py-2 text-xs/5 text-text-secondary"
                    >
                        <summary class="cursor-pointer"
                            >Session notices ({session.warnings
                                .length})</summary
                        >
                        <ul class="mt-2 list-disc space-y-1 pl-4">
                            {#each session.warnings as warning}<li>
                                    {warning}
                                </li>{/each}
                        </ul>
                    </details>{/if}
                <div
                    class="flex flex-wrap items-center justify-between gap-2 text-xs/5 text-text-muted"
                >
                    <span
                        >Question {questionIndex + 1} of {session.questions
                            .length}</span
                    ><span
                        >{["Easy", "Medium", "Hard"][question.difficulty]} · {question.format ===
                        0
                            ? "Multiple choice"
                            : "Free text"}</span
                    >
                </div>
                {#if material}
                    <section
                        class="overflow-hidden rounded-lg border border-border bg-surface"
                        aria-label="Question material"
                    >
                        <div class="min-w-0 p-4 sm:p-6">
                            {#if material.type === "image"}{#if imageFailed}<p
                                        class="py-8 text-center text-sm text-text-muted"
                                    >
                                        This image could not be loaded.
                                    </p>{:else}<img
                                        src={material.source}
                                        alt={material.alt}
                                        class="mx-auto max-h-80 max-w-full object-contain"
                                        onerror={() => {
                                            imageFailed = true;
                                        }}
                                    />{/if}
                            {:else if material.type === "latex"}<StudyText
                                    text={material.content}
                                    mathOnly
                                />
                            {:else}<pre
                                    class="max-h-80 overflow-auto font-mono text-[13px]/6"><code
                                        >{material.content}</code
                                    ></pre>{/if}
                        </div>
                        {#if question.materials.length > 1}<div
                                class="flex items-center justify-between border-t border-border px-4 py-2"
                            >
                                <button
                                    type="button"
                                    class={button}
                                    aria-label="Previous material"
                                    disabled={materialIndex === 0}
                                    onclick={() => {
                                        materialIndex--;
                                    }}>←</button
                                ><span
                                    class="text-xs tabular-nums text-text-muted"
                                    >Material {materialIndex + 1} of {question
                                        .materials.length}</span
                                ><button
                                    type="button"
                                    class={button}
                                    aria-label="Next material"
                                    disabled={materialIndex ===
                                        question.materials.length - 1}
                                    onclick={() => {
                                        materialIndex++;
                                    }}>→</button
                                >
                            </div>{/if}
                    </section>
                {/if}
                <section class="space-y-4" aria-labelledby="practice-question">
                    <h2
                        id="practice-question"
                        bind:this={questionHeading}
                        tabindex="-1"
                        class={["text-base/7 font-medium", focusRing]}
                    >
                        <StudyText text={question.text} />
                    </h2>
                    {#if question.format === 0}
                        <fieldset
                            class="space-y-2"
                            disabled={draft.revealed || !!session.closedAt}
                        >
                            <legend
                                class="mb-3 text-[13px]/5 text-text-secondary"
                                >Choose one answer</legend
                            >
                            {#each question.choices as choice, index}<label
                                    class={[
                                        "flex min-h-12 items-start gap-3 rounded-md border px-4 py-3 text-sm/6",
                                        draft.selectedChoiceIndex === index
                                            ? "border-control-border bg-selected"
                                            : "border-border bg-surface",
                                        !draft.revealed
                                            ? "cursor-pointer hover:bg-hover"
                                            : "",
                                    ]}
                                    ><input
                                        type="radio"
                                        name={`answer-${question.id}`}
                                        checked={draft.selectedChoiceIndex ===
                                            index}
                                        onchange={() => selectChoice(index)}
                                        class={[
                                            "mt-1 size-4 shrink-0 accent-accent-solid",
                                            focusRing,
                                        ]}
                                    /><span class="min-w-0 flex-1"
                                        ><StudyText
                                            text={choice}
                                            standaloneMath
                                        /></span
                                    ></label
                                >{/each}
                        </fieldset>
                    {:else}
                        <div class="space-y-2">
                            <div
                                class="flex items-center justify-between gap-3"
                            >
                                <label
                                    for="practice-answer"
                                    class="text-[13px]/5 text-text-secondary"
                                    >Your answer</label
                                ><span
                                    class="text-xs tabular-nums text-text-muted"
                                    >{draft.text.length} / {question.maxCharacters}</span
                                >
                            </div>
                            <textarea
                                id="practice-answer"
                                value={draft.text}
                                oninput={(event) =>
                                    changeText(event.currentTarget.value)}
                                disabled={draft.revealed || !!session.closedAt}
                                maxlength={question.maxCharacters}
                                rows="6"
                                placeholder="Write your answer in your own words…"
                                class={[input, "min-h-40 resize-y text-base/7"]}
                            ></textarea>
                        </div>
                    {/if}
                </section>
                {#if draft.revealed}<section
                        class="space-y-3 rounded-lg border border-border bg-surface p-4 sm:p-6"
                        aria-label="Example answer"
                    >
                        <div
                            class="flex flex-wrap items-center justify-between gap-2"
                        >
                            <h3 class="text-sm font-semibold">
                                Example answer
                            </h3>
                            {#if question.format === 0}<span
                                    class="text-xs/5 text-text-secondary"
                                    >{draft.selectedChoiceIndex ===
                                    question.correctChoiceIndex
                                        ? "Correct · 1 / 1"
                                        : "Incorrect · 0 / 1"}</span
                                >{/if}
                        </div>
                        {#if question.format === 0}<div class="text-sm/6">
                                <StudyText
                                    text={question.choices[
                                        question.correctChoiceIndex
                                    ]}
                                    standaloneMath
                                />
                            </div>{/if}
                        <div class="text-sm/6 text-text-secondary">
                            <StudyText text={question.exampleAnswer} />
                        </div>
                        {#if question.format === 1}<details
                                class="text-xs/5 text-text-muted"
                            >
                                <summary class="cursor-pointer"
                                    >What a good answer includes</summary
                                >
                                <div class="mt-2">
                                    <StudyText text={question.answerCriteria} />
                                </div>
                            </details>{/if}
                    </section>
                    <AnswerGrading
                        answer={draft}
                        busy={grading[question.id]}
                        error={gradingErrors[question.id]}
                        disabled={!!session.closedAt}
                        onGrade={(grade) => onGrade(question.id, grade)}
                        onAi={() => {
                            void onAiGrade(question.id);
                        }}
                    />{/if}
            </div>
        {/if}
    </main>
    {#if !showReview}<footer
            inert={closing}
            class="shrink-0 border-t border-border bg-sidebar px-4 py-3 sm:px-6"
        >
            <div class="mx-auto max-w-3xl space-y-3">
                <div class="flex items-center justify-between gap-3">
                    <span class="text-xs/5 tabular-nums text-text-muted"
                        >{submittedCount} of {session.questions.length} answered</span
                    ><span class="text-xs/5 text-text-muted"
                        >{answers.filter((answer) => answer.grade).length} graded</span
                    >
                </div>
                <progress
                    aria-label="Session progress"
                    value={submittedCount}
                    max={session.questions.length}
                    class="block h-1 w-full appearance-none overflow-hidden rounded-full bg-surface accent-accent-solid [&::-moz-progress-bar]:bg-accent-solid [&::-webkit-progress-bar]:bg-surface [&::-webkit-progress-value]:bg-accent-solid"
                ></progress>
                <div class="flex items-center justify-between gap-3">
                    <button
                        type="button"
                        class={button}
                        disabled={questionIndex === 0}
                        onclick={() => navigate(questionIndex - 1)}
                        >Previous</button
                    >
                    {#if session.closedAt || ((session.reviewedAt || reviewRequest > 0) && draft.revealed)}<button
                            type="button"
                            class={primaryButton}
                            onclick={() => {
                                viewingQuestion = false;
                            }}>Back to review</button
                        >
                    {:else if draft.revealed}{#if questionIndex + 1 === session.questions.length}<button
                                type="button"
                                class={primaryButton}
                                disabled={saving ||
                                    submittedCount !== session.questions.length}
                                onclick={onFinish}>Review answers</button
                            >{:else}<button
                                type="button"
                                class={primaryButton}
                                onclick={() => navigate(questionIndex + 1)}
                                >Next question →</button
                            >{/if}
                    {:else}<button
                            type="button"
                            class={primaryButton}
                            disabled={!canReveal || !!session.closedAt}
                            onclick={reveal}>Reveal answer</button
                        >{/if}
                </div>
            </div>
        </footer>{/if}
</section>
