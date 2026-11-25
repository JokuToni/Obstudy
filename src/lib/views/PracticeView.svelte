<script lang="ts">
    import { onMount, tick, untrack } from "svelte";
    import type {
        ExerciseDraftAnswer,
        ExerciseSession,
        AnswerGrade,
    } from "$lib/types/exercises";
    import StudyText from "$study/components/practice/StudyText.svelte";
    import DrawingEditor from "$lib/components/practice/DrawingEditor.svelte";
    import { hasAnswer, hasDrawing } from "$lib/drawing/answers";
    import type { DrawingAnswer } from "$lib/types/exercises";
    import AnswerEditor from "$lib/components/practice/AnswerEditor.svelte";
    import ResultsView from "./ResultsView.svelte";
    import GradingMenu from "$lib/components/practice/GradingMenu.svelte";
    import {
        button,
        focusRing,
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
    let mainContent = $state<HTMLElement>();
    let answerEditor = $state<AnswerEditor>();
    let editorMode = $state<"text" | "draw">("text");
    let gradingQuestionId = $state<string | null>(null);
    let gradeButton = $state<HTMLButtonElement>();
    let scrollFrame: number | null = null;
    let scrollTarget: number | null = null;
    const question = $derived(session.questions[questionIndex]);
    const draft: ExerciseDraftAnswer = $derived(
        answers.find((answer) => answer.questionId === question?.id) ?? {
            questionId: question?.id ?? "",
            text: "",
            selectedChoiceIndex: null,
            revealed: false,
        },
    );
    $effect(() => {
        question?.id;
        editorMode = untrack(() => draft.editorMode ?? "text");
    });
    function changeEditorMode(mode: "text" | "draw"): void {
        editorMode = mode;
        if (!draft.revealed && !session.closedAt)
            onChange({ ...draft, editorMode: mode });
        if (mode === "text") void tick().then(focusAnswer);
    }
    function changeDrawing(drawing: DrawingAnswer): void {
        onChange({ ...draft, drawing, editorMode: "draw" });
    }
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
            : hasAnswer(draft),
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
        void tick().then(focusAnswer);
        // Capture prevents the browser's radio-arrow behavior from selecting an
        // answer when the user only wants to move focus.
        document.addEventListener("keydown", hotkey, true);
        return () => {
            document.removeEventListener("keydown", hotkey, true);
            cancelResultsScroll();
        };
    });
    $effect(() => {
        if (showReview || closing) {
            gradingQuestionId = null;
        }
    });
    $effect(() => {
        cancelResultsScroll();
        if (showReview)
            void tick().then(() => {
                if (!showReview || closing) return;
                mainContent?.scrollTo({ top: 0 });
                mainContent?.focus({ preventScroll: true });
            });
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
        gradingQuestionId = null;
        questionIndex = Math.max(
            0,
            Math.min(session.questions.length - 1, index),
        );
        await tick();
        focusAnswer();
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
        if (canReveal && !draft.revealed && !session.closedAt) {
            onChange({ ...draft, revealed: true });
            void tick().then(() => {
                document
                    .querySelector('[aria-label="Example answer"]')
                    ?.scrollIntoView({ block: "nearest" });
                if (question.format === 1)
                    gradeButton?.focus({ preventScroll: true });
            });
        }
    }
    function focusAnswer(): void {
        if (showReview || closing || document.querySelector("dialog[open]"))
            return;
        const choices = Array.from(
            document.querySelectorAll<HTMLInputElement>(
                "input[data-practice-choice]:not(:disabled)",
            ),
        );
        if (question?.format === 1 && !draft.revealed && !session.closedAt)
            answerEditor?.focusToEnd();
        else if (choices.length)
            (choices.find((choice) => choice.checked) ?? choices[0]).focus();
        else questionHeading?.focus();
    }
    async function advance(): Promise<void> {
        if (questionIndex + 1 < session.questions.length)
            await navigate(questionIndex + 1);
        // onFinish serializes outstanding saves before entering results.
        else if (submittedCount === session.questions.length) await onFinish();
    }
    function forward(): void {
        if (
            session.closedAt ||
            ((session.reviewedAt || reviewRequest > 0) && draft.revealed)
        )
            viewingQuestion = false;
        else if (!draft.revealed) reveal();
        else if (question.format === 1 && !draft.grade && !grading[question.id])
            gradingQuestionId = question.id;
        else if (questionIndex + 1 < session.questions.length)
            void navigate(questionIndex + 1);
        else if (!saving && submittedCount === session.questions.length)
            void onFinish();
    }
    function chooseGrade(grade?: AnswerGrade, ai = false): void {
        const questionId = gradingQuestionId;
        if (!questionId) return;
        gradingQuestionId = null;
        if (grade) onGrade(questionId, grade);
        if (ai) void onAiGrade(questionId);
        void tick().then(advance);
    }
    async function cancelGrading(): Promise<void> {
        gradingQuestionId = null;
        await tick();
        gradeButton?.focus();
    }
    function cancelResultsScroll(): void {
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
        scrollFrame = null;
        scrollTarget = null;
    }
    function scrollResults(distance: number): void {
        const pane = mainContent;
        if (!pane) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            cancelResultsScroll();
            pane.scrollBy({ top: distance, behavior: "instant" });
            return;
        }
        const start = pane.scrollTop;
        const destination = Math.max(
            0,
            Math.min(
                pane.scrollHeight - pane.clientHeight,
                (scrollTarget ?? start) + distance,
            ),
        );
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
        scrollTarget = destination;
        const startedAt = performance.now();
        function animate(now: number): void {
            const progress = Math.min(1, Math.max(0, (now - startedAt) / 240));
            const eased = 1 - Math.pow(1 - progress, 3);
            pane!.scrollTo({
                top: start + (destination - start) * eased,
                behavior: "instant",
            });
            if (progress < 1) scrollFrame = requestAnimationFrame(animate);
            else {
                scrollFrame = null;
                scrollTarget = null;
            }
        }
        scrollFrame = requestAnimationFrame(animate);
    }
    function hotkey(event: KeyboardEvent): void {
        if (
            event.defaultPrevented ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            closing ||
            document.querySelector("dialog[open]")
        )
            return;
        if (
            event.target instanceof Element &&
            event.target.closest("[data-answer-editor-control]")
        )
            return;
        if (showReview) {
            if (
                event.target === mainContent &&
                (event.key === "ArrowUp" || event.key === "ArrowDown")
            ) {
                event.preventDefault();
                scrollResults(event.key === "ArrowDown" ? 120 : -120);
            }
            return;
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            const target = event.target;
            if (
                target instanceof Element &&
                target.closest("[data-answer-input]")
            ) {
                if (event.key !== "ArrowRight" || !answerEditor?.isAtEnd())
                    return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat) return;
            if (event.key === "ArrowLeft") {
                if (questionIndex > 0) void navigate(questionIndex - 1);
            } else if (
                question?.format === 0 &&
                !draft.revealed &&
                !session.closedAt
            ) {
                const choices = Array.from(
                    document.querySelectorAll<HTMLInputElement>(
                        "input[data-practice-choice]:not(:disabled)",
                    ),
                );
                const focusedIndex = choices.indexOf(
                    document.activeElement as HTMLInputElement,
                );
                const index =
                    focusedIndex >= 0
                        ? focusedIndex
                        : draft.selectedChoiceIndex;
                if (index === null) return;
                onChange({
                    ...draft,
                    text: question.choices[index],
                    selectedChoiceIndex: index,
                    revealed: true,
                });
                void tick().then(advance);
            } else forward();
        } else if (
            question?.format === 0 &&
            !draft.revealed &&
            !session.closedAt
        ) {
            const choices = Array.from(
                document.querySelectorAll<HTMLInputElement>(
                    "input[data-practice-choice]:not(:disabled)",
                ),
            );
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                event.stopPropagation();
                const current = choices.indexOf(
                    document.activeElement as HTMLInputElement,
                );
                const next =
                    current < 0
                        ? event.key === "ArrowDown"
                            ? 0
                            : choices.length - 1
                        : (current +
                              (event.key === "ArrowDown" ? 1 : -1) +
                              choices.length) %
                          choices.length;
                choices[next]?.focus();
                choices[next]
                    ?.closest("label")
                    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
            } else if (
                event.key === "Enter" &&
                document.activeElement instanceof HTMLInputElement &&
                choices.includes(document.activeElement)
            ) {
                event.preventDefault();
                event.stopPropagation();
            }
        }
    }
</script>

<section
    class="flex h-dvh min-h-0 flex-col bg-canvas text-[13px]/5 text-text-primary [&_button]:text-xs!"
    aria-label="Practice session"
>
    <header
        class="shrink-0 border-b border-border bg-sidebar px-3 py-1 sm:px-4"
    >
        <div class="mx-auto flex min-h-8 max-w-3xl items-center gap-3">
            <div class="flex min-w-0 flex-1 items-baseline gap-3">
                <h1
                    class="min-w-0 truncate text-[13px]/5 font-semibold"
                    title={session.noteTitle}
                >
                    {session.noteTitle}
                </h1>
                <p class="shrink-0 text-[11px]/4 text-text-muted">
                    {session.mode === "study"
                        ? "Study session"
                        : "Practice session"}
                </p>
            </div>
            <span role="status" class="text-[11px]/4 text-text-muted"
                >{saving
                    ? "Saving…"
                    : errorMessage
                      ? "Not saved"
                      : "Saved"}</span
            >
            <button
                type="button"
                class={[button, "min-h-7! px-2! py-1! text-xs!"]}
                disabled={closing}
                onclick={onClose}
                >{closing ? "Saving and exiting…" : "Save and exit"}</button
            >
        </div>
    </header>
    <div
        class="relative isolate h-0 min-h-0 flex-1 overflow-hidden"
        data-practice-body
    >
        <main
            bind:this={mainContent}
            onwheel={cancelResultsScroll}
            onpointerdown={cancelResultsScroll}
            tabindex="-1"
            inert={closing}
            class={["h-full overflow-y-auto px-3 sm:px-4", focusRing]}
        >
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
                <div
                    class="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-4 py-3 sm:py-4"
                >
                    {#if gradingErrors[question.id]}<p
                            role="alert"
                            class="shrink-0 rounded-md border border-border bg-surface p-3 text-sm/5 text-danger"
                        >
                            {gradingErrors[question.id]}
                        </p>{/if}
                    {#if session.warnings.length}<details
                            class="shrink-0 rounded-md border border-border bg-surface px-3 py-2 text-xs/5 text-text-secondary"
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
                        class="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs/5 text-text-muted"
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
                            class="shrink-0 overflow-hidden rounded-lg border border-border bg-surface"
                            aria-label="Question material"
                        >
                            <div class="min-w-0 p-3 sm:p-4">
                                {#if material.type === "image"}{#if imageFailed}<p
                                            class="py-8 text-center text-sm text-text-muted"
                                        >
                                            This image could not be loaded.
                                        </p>{:else}<img
                                            src={material.source}
                                            alt={material.alt}
                                            class="mx-auto max-h-48 max-w-full object-contain"
                                            onerror={() => {
                                                imageFailed = true;
                                            }}
                                        />{/if}
                                {:else if material.type === "latex"}<StudyText
                                        text={material.content}
                                        mathOnly
                                    />
                                {:else}<pre
                                        class="max-h-48 overflow-auto font-mono text-xs/5"><code
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
                    <section
                        class="flex min-h-0 flex-1 flex-col gap-3"
                        aria-labelledby="practice-question"
                    >
                        <h2
                            id="practice-question"
                            bind:this={questionHeading}
                            tabindex="-1"
                            class={[
                                "shrink-0 text-sm/6 font-medium",
                                focusRing,
                            ]}
                        >
                            <StudyText text={question.text} />
                        </h2>
                        {#if question.format === 0}
                            <fieldset
                                class="space-y-2"
                                disabled={draft.revealed || !!session.closedAt}
                            >
                                <legend
                                    class="mb-3 text-xs/5 text-text-secondary"
                                    >Choose one answer</legend
                                >
                                {#each question.choices as choice, index}<label
                                        class={[
                                            "flex min-h-10 items-start gap-2 rounded-md border px-3 py-2 text-[13px]/5 has-focus-visible:bg-hover",
                                            draft.selectedChoiceIndex === index
                                                ? "border-control-border bg-selected"
                                                : "border-border bg-surface",
                                            !draft.revealed
                                                ? "cursor-pointer hover:bg-hover"
                                                : "",
                                        ]}
                                        ><input
                                            type="radio"
                                            data-practice-choice
                                            name={`answer-${question.id}`}
                                            checked={draft.selectedChoiceIndex ===
                                                index}
                                            onchange={() => selectChoice(index)}
                                            class={[
                                                "mt-0.5 size-3.5 shrink-0 accent-accent-solid",
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
                            <div
                                class="flex min-h-[124px] flex-1 flex-col gap-2"
                            >
                                <div
                                    class="flex shrink-0 items-center justify-between gap-3"
                                >
                                    <label
                                        for="practice-answer"
                                        class="text-xs/5 text-text-secondary"
                                        >Your answer</label
                                    ><span
                                        class="text-xs tabular-nums text-text-muted"
                                        >{editorMode === "draw"
                                            ? "Drawing answer"
                                            : `${draft.text.length} / ${question.maxCharacters}`}</span
                                    >
                                </div>
                                <div
                                    role="tablist"
                                    aria-label="Answer format"
                                    data-answer-editor-control
                                    class="flex shrink-0 gap-1 border-b border-border"
                                >
                                    {#each ["text", "draw"] as mode}
                                        <button
                                            type="button"
                                            role="tab"
                                            id={`answer-${mode}-tab`}
                                            aria-controls={`answer-${mode}-panel`}
                                            aria-selected={editorMode === mode}
                                            tabindex={editorMode === mode
                                                ? 0
                                                : -1}
                                            class={[
                                                button,
                                                "rounded-b-none border-b-0",
                                                editorMode === mode
                                                    ? "bg-surface text-accent"
                                                    : "border-transparent bg-transparent text-text-muted",
                                            ]}
                                            onclick={() =>
                                                changeEditorMode(
                                                    mode as "text" | "draw",
                                                )}
                                            onkeydown={(event) => {
                                                if (
                                                    [
                                                        "ArrowLeft",
                                                        "ArrowRight",
                                                        "Home",
                                                        "End",
                                                    ].includes(event.key)
                                                ) {
                                                    event.preventDefault();
                                                    const next =
                                                        event.key === "Home"
                                                            ? "text"
                                                            : event.key ===
                                                                "End"
                                                              ? "draw"
                                                              : editorMode ===
                                                                  "text"
                                                                ? "draw"
                                                                : "text";
                                                    changeEditorMode(next);
                                                    void tick().then(() =>
                                                        document
                                                            .getElementById(
                                                                `answer-${next}-tab`,
                                                            )
                                                            ?.focus(),
                                                    );
                                                }
                                            }}
                                            >{mode === "text"
                                                ? "Text"
                                                : "Draw"}</button
                                        >
                                    {/each}
                                </div>
                                <div
                                    id={`answer-${editorMode}-panel`}
                                    role="tabpanel"
                                    aria-labelledby={`answer-${editorMode}-tab`}
                                    class="flex min-h-0 flex-1 flex-col"
                                >
                                    {#key question.id}
                                        {#if editorMode === "text"}
                                            <AnswerEditor
                                                bind:this={answerEditor}
                                                value={draft.text}
                                                onChange={changeText}
                                                disabled={draft.revealed ||
                                                    !!session.closedAt}
                                                maxCharacters={question.maxCharacters}
                                            />
                                        {:else}
                                            <DrawingEditor
                                                drawing={draft.drawing}
                                                onChange={changeDrawing}
                                                disabled={draft.revealed ||
                                                    !!session.closedAt}
                                            />
                                        {/if}
                                    {/key}
                                </div>
                            </div>
                        {/if}
                    </section>
                    {#if draft.revealed}<section
                            class="shrink-0 space-y-3 rounded-lg border border-border bg-surface p-4 sm:p-6"
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
                                        <StudyText
                                            text={question.answerCriteria}
                                        />
                                    </div>
                                </details>{/if}
                        </section>
                    {/if}
                </div>
            {/if}
        </main>
        {#if gradingQuestionId}<GradingMenu
                onGrade={(grade) => chooseGrade(grade)}
                onAi={() => chooseGrade(undefined, true)}
                onSkip={() => chooseGrade()}
                onCancel={cancelGrading}
                hasDrawing={hasDrawing(draft.drawing)}
            />{/if}
    </div>
    {#if !showReview}<footer
            inert={closing}
            class="shrink-0 border-t border-border bg-sidebar px-3 py-2 sm:px-4"
        >
            <div class="mx-auto max-w-3xl space-y-2">
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
                    {#if draft.revealed && question.format === 1 && !session.closedAt}
                        <div
                            class="flex min-w-0 flex-1 items-center justify-end gap-2 text-xs/5 text-text-muted"
                        >
                            <span role="status" class="truncate"
                                >{grading[question.id]
                                    ? "Grading with AI…"
                                    : draft.grade
                                      ? `Grade: ${draft.grade.points} / 1`
                                      : "Not graded yet"}</span
                            >
                            <button
                                type="button"
                                class={[button, "shrink-0"]}
                                disabled={grading[question.id] ||
                                    session.scheduledQuestionIds?.includes(
                                        question.id,
                                    )}
                                bind:this={gradeButton}
                                onclick={() => {
                                    gradingQuestionId = question.id;
                                }}>Grade answer</button
                            >
                        </div>
                    {/if}
                    {#if session.closedAt || ((session.reviewedAt || reviewRequest > 0) && draft.revealed)}<button
                            type="button"
                            class={[primaryButton, "min-h-8! px-3! py-1.5!"]}
                            onclick={forward}>Back to review</button
                        >
                    {:else if draft.revealed}{#if questionIndex + 1 === session.questions.length}<button
                                type="button"
                                class={[
                                    primaryButton,
                                    "min-h-8! px-3! py-1.5!",
                                ]}
                                disabled={saving ||
                                    submittedCount !== session.questions.length}
                                onclick={forward}>Review answers</button
                            >{:else}<button
                                type="button"
                                class={[
                                    primaryButton,
                                    "min-h-8! px-3! py-1.5!",
                                ]}
                                onclick={forward}>Next question →</button
                            >{/if}
                    {:else}<button
                            type="button"
                            class={[primaryButton, "min-h-8! px-3! py-1.5!"]}
                            disabled={!canReveal || !!session.closedAt}
                            onclick={forward}>Reveal answer</button
                        >{/if}
                </div>
            </div>
        </footer>{/if}
</section>
