<script lang="ts">
    import { onMount } from "svelte";
    import type { SyncedNote } from "$lib/types/notes";
    import { noteTitle } from "$lib/types/workspace";
    import {
        button,
        input,
        menuItem,
        primaryButton,
    } from "$lib/components/ui/styles";
    import Dropdown from "$lib/components/ui/Dropdown.svelte";
    import type { Difficulty, QuestionFormatSelection } from "$lib/types";
    import type {
        NoteGenerationState,
        QuestionGenerationRequest,
        NoteQuestionAction,
        NoteQuestionActionRequest,
    } from "$lib/types/questions";
    import { planBasicQuestions } from "$lib/questions/generation";

    let {
        note,
        generation,
        generationDisabledReason,
        onGenerate,
        onConfigureAi,
        onManage,
    }: {
        note: SyncedNote;
        generation?: NoteGenerationState;
        generationDisabledReason: string | null;
        onGenerate: (request: QuestionGenerationRequest) => Promise<void>;
        onConfigureAi: () => void;
        onManage: (request: NoteQuestionActionRequest) => Promise<void>;
    } = $props();
    let managementDialog: HTMLDialogElement;
    let questionCount = $state<number | undefined>(10);
    let difficulty = $state<Difficulty>(0);
    let questionFormat = $state<QuestionFormatSelection>(2);
    let pendingAction = $state<NoteQuestionAction | null>(null);
    let confirmationQuestionIds = $state<string[]>([]);
    const basicQuestionCount = $derived(
        note.questions.filter((question) => question.isBasicQuestion).length,
    );
    const difficulties = [
        { value: 0, label: "Easy" },
        { value: 1, label: "Medium" },
        { value: 2, label: "Hard" },
    ] as const;
    const formats = [
        { value: 2, label: "Mixed" },
        { value: 0, label: "Multiple choice" },
        { value: 1, label: "Free text" },
    ] as const;
    const basicRemaining = $derived(
        planBasicQuestions(note).reduce(
            (sum, task) => sum + task.remainingCount,
            0,
        ),
    );
    const busy = $derived(
        !!generation?.isGenerating || !!generation?.maintenanceAction,
    );
    const showAdditionalOptions = $derived(
        basicRemaining === 0 &&
            !(busy && generation?.progress?.mode === "basic"),
    );
    const disabledReason = $derived(
        !note.isAvailable
            ? "This note is unavailable."
            : note.parseError
              ? "Fix this note's topic structure before generating questions."
              : note.syncIssues.length
                ? "Review this note's topic changes before generating questions."
                : !note.topics.some((topic) => "text" in topic)
                  ? "This note has no subtopic content."
                  : null,
    );
    const invalidCount = $derived(
        showAdditionalOptions &&
            (!Number.isInteger(questionCount) ||
                !questionCount ||
                questionCount < 1 ||
                questionCount > 1000),
    );
    const progress = $derived(generation?.progress);
    const percent = $derived(
        progress && progress.requestedCount > 0
            ? Math.round(
                  (progress.generatedCount / progress.requestedCount) * 100,
              )
            : 0,
    );
    onMount(() => {
        questionCount = note.savedPracticeSettings?.questionCount ?? 10;
        difficulty = note.savedPracticeSettings?.difficulty ?? 0;
        questionFormat = note.savedPracticeSettings?.questionFormat ?? 2;
    });
    $effect(() => {
        const request = generation?.remainingRequest;
        if (request) {
            questionCount = request.questionCount;
            difficulty = request.difficulty ?? 0;
            questionFormat = request.questionFormat ?? 2;
        }
    });
    function closeManagement(): void {
        managementDialog.close();
        pendingAction = null;
    }
    function configureAi(): void {
        closeManagement();
        onConfigureAi();
    }
    function generate(): void {
        if (busy || pendingAction || disabledReason || invalidCount) return;
        if (generationDisabledReason) {
            configureAi();
            return;
        }
        void onGenerate({
            noteId: note.id,
            questionCount: showAdditionalOptions ? (questionCount ?? 10) : 1,
            topicIds: [],
            difficulty,
            questionFormat,
        });
    }
    function requestAction(action: NoteQuestionAction): void {
        if (busy) return;
        confirmationQuestionIds = note.questions.map((question) => question.id);
        pendingAction = action;
    }
    function confirmAction(): void {
        if (busy || !pendingAction) return;
        void onManage({
            noteId: note.id,
            action: pendingAction,
            expectedQuestionIds: confirmationQuestionIds,
        });
        pendingAction = null;
    }
    const answeredQuestionCount = $derived(
        new Set(
            note.questions
                .filter((question) => question.lastAnsweredAt !== null)
                .map((question) => question.id),
        ).size,
    );
    const gradedAnswers = $derived(
        note.answers.filter((answer) => answer.points !== null),
    );
    const averagePoints = $derived(
        gradedAnswers.length
            ? gradedAnswers.reduce(
                  (sum, answer) => sum + (answer.points ?? 0),
                  0,
              ) / gradedAnswers.length
            : null,
    );
    const lastSubmission = $derived(
        note.answers.reduce<string | null>(
            (latest, answer) =>
                !latest || Date.parse(answer.answeredAt) > Date.parse(latest)
                    ? answer.answeredAt
                    : latest,
            null,
        ),
    );
</script>

<section class="space-y-6" aria-label={`${noteTitle(note)} progress`}>
    <div>
        <div class="flex flex-wrap items-center gap-3">
            <h2 class="min-w-0 break-words text-[22px]/[30px] font-semibold">
                {noteTitle(note)}
            </h2>
            <button
                type="button"
                class={[button, "shrink-0"]}
                aria-haspopup="dialog"
                aria-controls={`manage-questions-${note.id}`}
                onclick={(event) => {
                    // WebKit does not focus buttons on pointer clicks by default.
                    event.currentTarget.focus();
                    managementDialog.showModal();
                }}>Manage questions</button
            >
        </div>
        <p class="mt-2 text-sm text-text-secondary">
            Study progress and questions for this note.
        </p>
    </div>
    <dl class="grid grid-cols-2 gap-x-4 gap-y-6">
        {#each [{ label: "Questions", value: note.questions.length }, { label: "Questions answered", value: answeredQuestionCount }, { label: "Answers submitted", value: note.answers.length }, { label: "Average points per graded answer · all time", value: averagePoints === null ? "—" : averagePoints.toFixed(1) }] as statistic}
            <div>
                <dt class="text-[13px]/5 text-text-secondary">
                    {statistic.label}
                </dt>
                <dd class="mt-2 text-[28px]/9 tabular-nums">
                    {statistic.value}
                </dd>
            </div>
        {/each}
    </dl>
    <p class="text-xs/5 text-text-muted">
        {note.answers.length - gradedAnswers.length} ungraded answers · Last submission:
        {lastSubmission ? new Date(lastSubmission).toLocaleString() : "—"}.
        Unfinished drafts are saved separately and do not count as submitted
        answers.
    </p>
    {#if !note.questions.length}<p class="text-sm text-text-muted">
            No questions have been generated for this note yet.
        </p>{/if}
    <dialog
        bind:this={managementDialog}
        id={`manage-questions-${note.id}`}
        aria-labelledby={`manage-questions-title-${note.id}`}
        onclose={() => {
            pendingAction = null;
        }}
        class="m-auto max-h-[calc(100dvh_-_32px)] w-[calc(100%_-_32px)] max-w-3xl space-y-4 overflow-y-auto rounded-lg border border-border bg-canvas p-4 text-text-primary shadow-xl backdrop:bg-scrim/60 sm:p-6"
    >
        <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 space-y-1">
                <h2
                    id={`manage-questions-title-${note.id}`}
                    class="text-base font-semibold"
                >
                    Manage questions
                </h2>
                <p class="break-words text-sm/5 text-text-secondary">
                    {noteTitle(note)}
                </p>
            </div>
            <button
                type="button"
                class={[button, "shrink-0"]}
                onclick={closeManagement}>Close</button
            >
        </div>
        {#if showAdditionalOptions}
            <p class="text-xs/5 text-text-secondary">
                Generate additional practice questions from all topics in this
                note. Additional questions do not get study cards.
            </p>
            <div class="grid min-w-0 gap-4 lg:grid-cols-3">
                <div class="min-w-0 space-y-2">
                    <label
                        for={`generation-count-${note.id}`}
                        class="block text-[13px]/5 font-medium"
                        >Number of questions</label
                    >
                    <input
                        id={`generation-count-${note.id}`}
                        type="number"
                        min="1"
                        max="1000"
                        step="1"
                        bind:value={questionCount}
                        disabled={busy}
                        aria-invalid={invalidCount}
                        aria-describedby={invalidCount
                            ? `generation-count-error-${note.id}`
                            : undefined}
                        class={input}
                    />
                    {#if invalidCount}<p
                            id={`generation-count-error-${note.id}`}
                            class="text-xs/4 text-danger"
                        >
                            Enter a whole number from 1 to 1000.
                        </p>{/if}
                </div>
                <div class="min-w-0 space-y-2">
                    <span
                        id={`generation-difficulty-label-${note.id}`}
                        class="block text-[13px]/5 font-medium">Difficulty</span
                    >
                    <Dropdown
                        id={`generation-difficulty-${note.id}`}
                        label={difficulties.find(
                            (option) => option.value === difficulty,
                        )!.label}
                        labelledBy={`generation-difficulty-label-${note.id}`}
                        disabled={busy}
                        fullWidth
                    >
                        {#snippet children(close)}
                            {#each difficulties as option}<button
                                    type="button"
                                    class={menuItem}
                                    aria-pressed={difficulty === option.value}
                                    onclick={() => {
                                        difficulty = option.value;
                                        close();
                                    }}>{option.label}</button
                                >{/each}
                        {/snippet}
                    </Dropdown>
                </div>
                <div class="min-w-0 space-y-2">
                    <span
                        id={`generation-format-label-${note.id}`}
                        class="block text-[13px]/5 font-medium"
                        >Question format</span
                    >
                    <Dropdown
                        id={`generation-format-${note.id}`}
                        label={formats.find(
                            (option) => option.value === questionFormat,
                        )!.label}
                        labelledBy={`generation-format-label-${note.id}`}
                        disabled={busy}
                        fullWidth
                    >
                        {#snippet children(close)}
                            {#each formats as option}<button
                                    type="button"
                                    class={menuItem}
                                    aria-pressed={questionFormat ===
                                        option.value}
                                    onclick={() => {
                                        questionFormat = option.value;
                                        close();
                                    }}>{option.label}</button
                                >{/each}
                        {/snippet}
                    </Dropdown>
                </div>
            </div>
        {:else}
            <p class="text-xs/5 text-text-secondary">
                {basicRemaining} basic questions remain across this note. Basic questions
                include study cards.
            </p>
        {/if}
        <div class="flex flex-wrap gap-2">
            <button
                type="button"
                class={primaryButton}
                disabled={busy ||
                    !!pendingAction ||
                    !!disabledReason ||
                    invalidCount ||
                    generationDisabledReason === "Loading AI integrations…"}
                onclick={generate}
                >{busy ? "Generating…" : "Generate questions"}</button
            >
            <button
                type="button"
                class={button}
                disabled={busy || !!pendingAction || !note.questions.length}
                onclick={() => requestAction("remove")}>Remove questions</button
            >
            <button
                type="button"
                class={button}
                disabled={busy || !!pendingAction || !basicQuestionCount}
                onclick={() => requestAction("reset")}
                >Reset study schedule</button
            >
        </div>
        {#if pendingAction}
            <div
                class="space-y-3 rounded-md border border-border bg-surface p-4"
                role="group"
                aria-label={pendingAction === "remove"
                    ? "Confirm question removal"
                    : "Confirm schedule reset"}
            >
                <p class="text-sm/5 text-text-primary">
                    {pendingAction === "remove"
                        ? `Remove all ${confirmationQuestionIds.length} questions from this note? Past answers and exercise results will be kept.`
                        : `Reset the study schedule for ${basicQuestionCount} basic questions? Their learning progress will restart; questions, answers, and results will be kept.`}
                </p>
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        class={[button, "text-danger"]}
                        onclick={confirmAction}
                        disabled={busy}
                        >{pendingAction === "remove"
                            ? "Remove all questions"
                            : "Reset schedule"}</button
                    >
                    <button
                        type="button"
                        class={button}
                        onclick={() => {
                            pendingAction = null;
                        }}
                        disabled={busy}>Cancel</button
                    >
                </div>
            </div>
        {/if}
        {#if disabledReason || generationDisabledReason}<div class="space-y-2">
                <p class="text-xs/5 text-text-muted">
                    {disabledReason ?? generationDisabledReason}
                </p>
                {#if generationDisabledReason && generationDisabledReason !== "Loading AI integrations…"}<button
                        type="button"
                        class={button}
                        onclick={configureAi}>Open AI integrations</button
                    >{/if}
            </div>{/if}
        {#if generation}
            <div class="space-y-2" aria-busy={busy}>
                {#if generation.isGenerating || progress}
                    <div
                        class="flex flex-wrap items-center justify-between gap-2 text-xs/5 text-text-secondary"
                    >
                        <span
                            >{busy
                                ? progress
                                    ? `Generating ${progress.mode} questions…`
                                    : "Preparing question generation…"
                                : "Generation progress"}</span
                        >
                        {#if progress}<span class="tabular-nums"
                                >{progress.generatedCount} of {progress.requestedCount}
                                saved · {percent}%</span
                            >{/if}
                    </div>
                    <progress
                        aria-label="Question generation progress"
                        max={progress?.requestedCount || 1}
                        value={progress ? progress.generatedCount : undefined}
                        class="block h-2 w-full appearance-none overflow-hidden rounded-full border border-border bg-surface accent-accent-solid [&::-moz-progress-bar]:bg-accent-solid [&::-webkit-progress-bar]:bg-surface [&::-webkit-progress-value]:bg-accent-solid"
                    ></progress>
                {/if}
                <p role="status" class="text-xs/5 text-text-secondary">
                    {generation.isGenerating
                        ? "Questions are saved after each batch. You can switch tabs while generation continues."
                        : generation.maintenanceAction
                          ? generation.maintenanceAction === "remove"
                              ? "Removing questions…"
                              : "Resetting study schedule…"
                          : (generation.message ?? "")}
                </p>
                {#if generation.error}<p
                        role="alert"
                        class="break-words text-sm/5 text-danger"
                    >
                        {generation.error}
                        {progress
                            ? "Saved questions are preserved. Try generating again to continue."
                            : "Please try again."}
                    </p>{/if}
                {#if generation.errorDetails}<details
                        class="text-xs/5 text-text-muted"
                    >
                        <summary class="cursor-pointer"
                            >Technical details</summary
                        >
                        <pre
                            class="mt-2 whitespace-pre-wrap break-words font-mono">{generation.errorDetails}</pre>
                    </details>{/if}
                {#if generation.warnings.length}<details
                        class="text-xs/5 text-warning"
                    >
                        <summary class="cursor-pointer"
                            >Generation notices ({generation.warnings
                                .length})</summary
                        >
                        <ul class="mt-2 list-disc space-y-1 pl-4">
                            {#each generation.warnings as warning}<li
                                    class="break-words"
                                >
                                    {warning}
                                </li>{/each}
                        </ul>
                    </details>{/if}
            </div>
        {/if}
        {#if !note.questions.length}<p class="text-xs text-text-muted">
                Generate questions before removing them or resetting their study
                schedule.
            </p>
        {:else if !basicQuestionCount}<p class="text-xs text-text-muted">
                Only basic questions have a study schedule to reset.
            </p>{/if}
    </dialog>
</section>
