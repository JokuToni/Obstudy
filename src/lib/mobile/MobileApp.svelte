<script lang="ts">
    import type { Snippet } from "svelte";
    import { onMount, untrack } from "svelte";
    import StudyText from "$lib/components/practice/StudyText.svelte";
    import ExitConfirmation from "$lib/components/practice/ExitConfirmation.svelte";
    import { button, primaryButton, input } from "$lib/components/ui/styles";
    import { readyStudyQuestions } from "$lib/exercises/selection";
    import { mobileNote, MobileStudyService } from "./study";
    import { mobileRepository } from "./repository";
    import { sampleCatalog } from "./sample";
    import type { MobileState, MobileSyncTransport } from "./types";
    import type {
        ExerciseDraftAnswer,
        AnswerGrade,
    } from "$lib/types/exercises";
    import type { StudyMode } from "$lib/types";

    let {
        syncTransport = null,
        accountScope = "",
        deviceId,
        accountPanel,
    }: {
        syncTransport?: MobileSyncTransport | null;
        accountScope?: string;
        deviceId?: string;
        accountPanel?: Snippet;
    } = $props();
    const service = untrack(
        () =>
            new MobileStudyService(
                mobileRepository(accountScope),
                () => new Date(),
                () => crypto.randomUUID(),
                deviceId ?? null,
            ),
    );
    const touchButton = `${button} min-h-11! px-3! text-sm!`;
    const touchPrimary = `${primaryButton} min-h-11! text-sm!`;
    let studyData = $state<MobileState | null>(null);
    let loading = $state(true);
    let syncing = $state(false);
    let error = $state<string | null>(null);
    let busy = $state(false);
    let saveCount = $state(0);
    const saving = $derived(saveCount > 0);
    let selectedSetId = $state<string | null>(null);
    let mode = $state<StudyMode>("study");
    let count = $state<number | undefined>(10);
    let activeId = $state<string | null>(null);
    let questionIndex = $state(0);
    let reviewing = $state(false);
    let confirmExit = $state(false);
    let text = $state("");
    let choice = $state<number | null>(null);
    let now = $state(new Date());
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingSave: Promise<void> = Promise.resolve();
    const session = $derived(
        studyData?.sessions.find((session) => session.id === activeId),
    );
    const question = $derived(session?.questions[questionIndex]);
    const draft: ExerciseDraftAnswer = $derived(
        session?.draftAnswers.find(
            (answer) => answer.questionId === question?.id,
        ) ?? {
            questionId: question?.id ?? "",
            text: "",
            selectedChoiceIndex: null,
            revealed: false,
        },
    );
    const answerKey = $derived(`${session?.id ?? ""}:${question?.id ?? ""}`);
    const selectedSet = $derived(
        studyData?.catalog?.sets.find((set) => set.id === selectedSetId),
    );
    const ready = $derived(
        studyData && selectedSet && selectedSet.isStudying !== false
            ? readyStudyQuestions(mobileNote(studyData, selectedSet), now)
                  .questions.length
            : 0,
    );
    const ungraded = $derived(
        session?.draftAnswers.filter(
            (answer) => answer.text.trim() && !answer.grade,
        ).length ?? 0,
    );
    const levels = [
        { points: 0, label: "Incorrect", color: "text-danger!" },
        { points: 0.5, label: "Partly correct", color: "text-warning!" },
        { points: 1, label: "Correct", color: "text-success!" },
    ] as const;
    $effect(() => {
        answerKey;
        untrack(() => {
            text = draft.text;
            choice = draft.selectedChoiceIndex;
            dirty = false;
        });
    });
    function message(error: unknown): string {
        return error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Unable to save your study data. Please try again.";
    }
    async function load(): Promise<void> {
        loading = true;
        try {
            studyData = await service.load();
            error = null;
            if (syncTransport) void synchronize();
        } catch (caught) {
            error = message(caught);
        } finally {
            loading = false;
        }
    }
    async function synchronize(): Promise<void> {
        if (!syncTransport || syncing || !studyData) return;
        syncing = true;
        let succeeded = false;
        try {
            await flushDraft();
            await service.synchronize(syncTransport);
            studyData = service.state;
            error = null;
            now = new Date();
            succeeded = true;
        } catch (caught) {
            error = message(caught);
        } finally {
            syncing = false;
            if (succeeded && service.state.outbox.length) void synchronize();
        }
    }
    function flushDraft(): Promise<void> {
        clearTimeout(timer);
        if (dirty && session && question && !draft.revealed) {
            const exerciseId = session.id;
            const key = answerKey;
            const answer: ExerciseDraftAnswer = {
                questionId: question.id,
                text,
                selectedChoiceIndex: choice,
                revealed: false,
            };
            dirty = false;
            saveCount++;
            pendingSave = pendingSave
                .catch(() => {})
                .then(async () => {
                    try {
                        await service.saveAnswer(exerciseId, answer);
                        studyData = service.state;
                        error = null;
                    } catch (caught) {
                        if (answerKey === key) dirty = true;
                        error = message(caught);
                        throw caught;
                    } finally {
                        saveCount--;
                    }
                });
        }
        return pendingSave;
    }
    function edit(): void {
        dirty = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
            void flushDraft().catch(() => {});
        }, 250);
    }
    async function act(operation: () => Promise<unknown>): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            await flushDraft();
            await operation();
            studyData = service.state;
            error = null;
            now = new Date();
        } catch (caught) {
            error = message(caught);
        } finally {
            busy = false;
            if (syncTransport) void synchronize();
        }
    }
    function resume(id: string): void {
        activeId = id;
        const saved = studyData?.sessions.find((session) => session.id === id);
        questionIndex = Math.max(
            0,
            saved?.questions.findIndex(
                (question) =>
                    !saved.draftAnswers.some(
                        (answer) =>
                            answer.questionId === question.id &&
                            answer.revealed,
                    ),
            ) ?? 0,
        );
        reviewing = !!saved?.reviewedAt;
    }
    async function start(): Promise<void> {
        if (
            !selectedSet ||
            !count ||
            !Number.isInteger(count) ||
            count < 1 ||
            count > 100
        )
            return;
        const created = await service.startSession(selectedSet.id, mode, count);
        studyData = service.state;
        resume(created.id);
    }
    async function reveal(): Promise<void> {
        if (!session || !question) return;
        await service.saveAnswer(session.id, {
            questionId: question.id,
            text,
            selectedChoiceIndex: choice,
            revealed: true,
        });
    }
    async function grade(
        questionId: string,
        points: AnswerGrade["points"],
    ): Promise<void> {
        const answer = session?.draftAnswers.find(
            (answer) => answer.questionId === questionId,
        );
        if (!session || !answer) return;
        await service.saveAnswer(session.id, {
            ...answer,
            grade: { points, source: "self", feedback: "" },
        });
    }
    async function next(): Promise<void> {
        if (!session) return;
        if (questionIndex + 1 < session.questions.length) questionIndex++;
        else {
            await service.finishSession(session.id);
            reviewing = true;
        }
    }
    async function exit(discard = false): Promise<void> {
        if (!session) {
            activeId = null;
            return;
        }
        if (ungraded && !discard) {
            confirmExit = true;
            return;
        }
        await service.closeSession(session.id, discard);
        confirmExit = false;
        activeId = null;
        reviewing = false;
    }
    onMount(() => {
        void load();
        const update = () => {
            now = new Date();
            void flushDraft().catch(() => {});
        };
        document.addEventListener("visibilitychange", update);
        window.addEventListener("pagehide", update);
        window.addEventListener("blur", update);
        const onOnline = () => void synchronize();
        window.addEventListener("online", onOnline);
        window.addEventListener("focus", onOnline);
        const clock = setInterval(() => {
            now = new Date();
            if (!busy && !saving) void synchronize();
        }, 60000);
        return () => {
            clearTimeout(timer);
            clearInterval(clock);
            window.removeEventListener("online", onOnline);
            window.removeEventListener("focus", onOnline);
            document.removeEventListener("visibilitychange", update);
            window.removeEventListener("pagehide", update);
            window.removeEventListener("blur", update);
            void flushDraft().catch(() => {});
        };
    });
</script>

<div
    class="flex h-dvh min-h-0 flex-col bg-canvas pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-text-primary"
    aria-label="Obstudy mobile"
>
    <header
        class="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border bg-sidebar px-4 py-2"
    >
        <div class="min-w-0">
            <h1 class="truncate text-base/6 font-semibold">
                {session ? session.noteTitle : "Study sets"}
            </h1>
            <p class="text-xs/5 text-text-muted">
                {session
                    ? session.mode === "study"
                        ? "Study session"
                        : "Practice session"
                    : "Saved on this device"}
            </p>
        </div>
        {#if !session && syncTransport}<button
                type="button"
                class={touchButton}
                disabled={busy || loading || syncing}
                onclick={synchronize}>Sync</button
            >{/if}
        {#if session}<button
                type="button"
                class={touchButton}
                disabled={busy}
                onclick={() => act(() => exit())}>Save and exit</button
            >{/if}
    </header>
    {#if error}<div
            role="alert"
            class="shrink-0 border-b border-border px-4 py-3 text-sm/5 text-danger"
        >
            <p>{error}</p>
            <button
                type="button"
                class={[touchButton, "mt-2"]}
                onclick={() => (studyData ? act(() => flushDraft()) : load())}
                >Try again</button
            >
        </div>{/if}
    <main class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {#if loading}<p role="status" class="text-sm text-text-muted">
                Loading study sets…
            </p>
        {:else if !studyData}<p class="text-sm text-text-muted">
                Your study data could not be loaded.
            </p>
        {:else if !session}
            {@render accountPanel?.()}
            {#if studyData.sessions.some((session) => !session.closedAt)}<section
                    class="mb-6 space-y-2"
                    aria-label="Unfinished sessions"
                >
                    <h2 class="text-sm/5 font-semibold">Continue studying</h2>
                    {#each studyData.sessions.filter((session) => !session.closedAt) as saved}<button
                            type="button"
                            class="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border border-border bg-sidebar px-3 py-3 text-left"
                            onclick={() => resume(saved.id)}
                            ><span class="min-w-0 truncate text-sm"
                                >{saved.noteTitle}</span
                            ><span class="shrink-0 text-xs text-text-muted"
                                >Resume · {saved.draftAnswers.filter(
                                    (answer) => answer.revealed,
                                ).length}/{saved.questions.length}</span
                            ></button
                        >{/each}
                </section>{/if}
            {#if !studyData.catalog?.sets.length}<section
                    class="rounded-lg border border-border bg-sidebar p-4"
                >
                    <h2 class="text-base/6 font-semibold">No study sets yet</h2>
                    <p class="mt-2 text-sm/6 text-text-muted">
                        No study sets have been added to this device yet.
                    </p>
                    {#if !studyData.catalog}<button
                            type="button"
                            class={[touchPrimary, "mt-4"]}
                            disabled={busy}
                            onclick={() =>
                                act(async () => {
                                    await service.installCatalog(
                                        sampleCatalog(),
                                    );
                                    selectedSetId = "sample-intervals";
                                })}>Try sample questions</button
                        >{/if}
                </section>
            {:else}<section aria-label="Saved study sets" class="space-y-3">
                    {#each studyData.catalog.sets as set}<button
                            type="button"
                            aria-pressed={selectedSetId === set.id}
                            class={[
                                "flex min-h-16 w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left",
                                selectedSetId === set.id
                                    ? "border-accent bg-selected"
                                    : "border-border bg-sidebar",
                            ]}
                            onclick={() => (selectedSetId = set.id)}
                            ><span
                                class="min-w-0 break-words text-sm font-medium"
                                >{set.title}</span
                            ><span
                                class="shrink-0 text-right text-xs/5 text-text-muted"
                                >{readyStudyQuestions(
                                    mobileNote(studyData, set),
                                    now,
                                ).questions.length} due<br />{set.questions
                                    .length} questions</span
                            ></button
                        >{/each}
                </section>{/if}
            {#if selectedSet}<section
                    class="mt-6 space-y-4"
                    aria-label="Session options"
                >
                    <div class="grid grid-cols-2 gap-2">
                        {#each ["study", "practice"] as option}<button
                                type="button"
                                class={[
                                    touchButton,
                                    mode === option
                                        ? "bg-selected! text-accent!"
                                        : "",
                                ]}
                                aria-pressed={mode === option}
                                onclick={() => (mode = option as StudyMode)}
                                >{option === "study"
                                    ? "Study"
                                    : "Practice"}</button
                            >{/each}
                    </div>
                    <label class="block space-y-2 text-sm"
                        ><span>Number of questions</span><input
                            aria-label="Number of questions"
                            class={[input, "min-h-11! text-base!"]}
                            type="number"
                            min="1"
                            max="100"
                            step="1"
                            bind:value={count}
                        /></label
                    >{#if mode === "study" && !ready}<p
                            class="text-sm/5 text-text-muted"
                        >
                            Nothing is due now. Choose Practice to use saved
                            questions.
                        </p>{/if}<button
                        type="button"
                        class={[touchPrimary, "w-full"]}
                        disabled={busy ||
                            !count ||
                            !Number.isInteger(count) ||
                            count < 1 ||
                            count > 100 ||
                            (mode === "study" && !ready)}
                        onclick={() => act(start)}>Start session</button
                    >
                </section>{/if}
        {:else if reviewing}
            <section aria-label="Session results" class="space-y-4">
                <h2 class="text-lg/6 font-semibold">Review your answers</h2>
                <p class="text-sm/6 text-text-muted">
                    {session.draftAnswers.filter((answer) => answer.grade)
                        .length} graded · {session.draftAnswers.reduce(
                        (sum, answer) => sum + (answer.grade?.points ?? 0),
                        0,
                    )} points
                </p>
                {#each session.questions as savedQuestion, index}{@const answer =
                        session.draftAnswers.find(
                            (answer) => answer.questionId === savedQuestion.id,
                        )}
                    <section
                        class="space-y-3 rounded-lg border border-border bg-sidebar p-3"
                        aria-label={`Question ${index + 1} review`}
                    >
                        <h3 class="text-xs text-text-muted">
                            Question {index + 1}
                        </h3>
                        <StudyText text={savedQuestion.text} />
                        <div
                            class="rounded-md border border-border bg-surface p-3 text-sm"
                        >
                            <StudyText text={answer?.text || "No answer"} />
                        </div>
                        {#if answer?.revealed}<p
                                class="text-xs text-text-muted"
                            >
                                Example answer
                            </p>
                            <StudyText
                                text={savedQuestion.exampleAnswer}
                            />{/if}{#if answer?.grade}<p
                                class="text-sm font-medium"
                            >
                                Graded · {answer.grade.points} / 1
                            </p>{:else if answer?.revealed}<div
                                class="flex flex-col gap-2"
                                aria-label="Self grading"
                            >
                                {#each levels as level}<button
                                        type="button"
                                        class={[touchButton, level.color]}
                                        disabled={busy}
                                        onclick={() =>
                                            act(() =>
                                                grade(
                                                    savedQuestion.id,
                                                    level.points,
                                                ),
                                            )}>{level.label}</button
                                    >{/each}
                            </div>{/if}<button
                            type="button"
                            class={touchButton}
                            onclick={() => {
                                questionIndex = index;
                                reviewing = false;
                            }}>View question</button
                        >
                    </section>{/each}
            </section>
        {:else if question}
            <section
                class="flex min-h-full flex-col gap-4"
                aria-label="Current question"
            >
                <p class="text-xs/5 text-text-muted">
                    Question {questionIndex + 1} of {session.questions.length} · {[
                        "Easy",
                        "Medium",
                        "Hard",
                    ][question.difficulty]}
                </p>
                <h2 class="text-base/6 font-medium">
                    <StudyText text={question.text} />
                </h2>
                {#each question.materials as material}<div
                        class="rounded-lg border border-border bg-sidebar p-3"
                    >
                        {#if material.type === "latex"}<StudyText
                                text={material.content}
                                mathOnly
                            />{:else if material.type === "image"}<img
                                src={material.source}
                                alt={material.alt}
                                class="max-h-48 max-w-full object-contain"
                            />{:else}<pre class="overflow-x-auto text-xs"><code
                                    >{material.content}</code
                                ></pre>{/if}
                    </div>{/each}
                {#if question.format === 0}<fieldset
                        class="space-y-2"
                        disabled={draft.revealed || busy}
                    >
                        <legend class="mb-2 text-sm text-text-muted"
                            >Choose one answer</legend
                        >{#each question.choices as option, index}<label
                                class={[
                                    "flex min-h-12 items-start gap-3 rounded-lg border px-3 py-3 text-sm/6",
                                    choice === index
                                        ? "border-accent bg-selected"
                                        : "border-border bg-surface",
                                ]}
                                ><input
                                    type="radio"
                                    name="mobile-answer"
                                    value={index}
                                    bind:group={choice}
                                    onchange={edit}
                                    class="mt-1 size-4 shrink-0 accent-accent-solid"
                                /><span class="min-w-0"
                                    ><StudyText
                                        text={option}
                                        standaloneMath
                                    /></span
                                ></label
                            >{/each}
                    </fieldset>
                {:else}<label
                        class="flex min-h-40 flex-1 flex-col gap-2 text-sm"
                        ><span class="text-text-muted">Your answer</span
                        ><textarea
                            class="min-h-36 w-full flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-3 text-base/6 text-text-primary"
                            aria-label="Your answer"
                            bind:value={text}
                            oninput={edit}
                            maxlength={question.maxCharacters}
                            disabled={draft.revealed || busy}
                            placeholder="Write your answer…"></textarea><span
                            class="text-right text-xs text-text-muted"
                            >{text.length} / {question.maxCharacters}</span
                        ></label
                    >{/if}
                {#if draft.revealed}<section
                        class="space-y-3 rounded-lg border border-border bg-sidebar p-3"
                        aria-label="Example answer"
                    >
                        <h3 class="text-sm font-semibold">Example answer</h3>
                        <StudyText
                            text={question.exampleAnswer}
                        />{#if draft.grade}<p class="text-sm font-medium">
                                Graded · {draft.grade.points} / 1
                            </p>{:else}<div
                                class="flex flex-col gap-2"
                                aria-label="Self grading"
                            >
                                {#each levels as level}<button
                                        type="button"
                                        class={[touchButton, level.color]}
                                        disabled={busy}
                                        onclick={() =>
                                            act(() =>
                                                grade(
                                                    question.id,
                                                    level.points,
                                                ),
                                            )}>{level.label}</button
                                    >{/each}
                            </div>
                            <p class="text-xs/5 text-text-muted">
                                You can also grade this answer in results.
                            </p>{/if}
                    </section>{/if}
            </section>
        {/if}
    </main>
    {#if session}<footer
            class="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-sidebar px-4 py-3"
        >
            <span
                role="status"
                class="hidden text-xs text-text-muted min-[360px]:block"
                >{saving || busy ? "Saving…" : "Saved locally"}</span
            >
            <div class="flex items-center gap-2">
                {#if !reviewing}<button
                        type="button"
                        class={touchButton}
                        disabled={busy || questionIndex === 0}
                        onclick={() =>
                            act(async () => {
                                questionIndex--;
                            })}>Previous</button
                    >{#if !draft.revealed}<button
                            type="button"
                            class={touchPrimary}
                            disabled={busy ||
                                (question?.format === 0
                                    ? choice === null
                                    : !text.trim())}
                            onclick={() => act(reveal)}>Reveal answer</button
                        >{:else}<button
                            type="button"
                            class={touchPrimary}
                            disabled={busy}
                            onclick={() => act(next)}
                            >{questionIndex + 1 === session.questions.length
                                ? "Review answers"
                                : "Next question"}</button
                        >{/if}{:else}<button
                        type="button"
                        class={touchPrimary}
                        disabled={busy}
                        onclick={() => act(() => exit())}>Finish session</button
                    >{/if}
            </div>
        </footer>{/if}
</div>
{#if confirmExit}<div class="contents [&_button]:min-h-11! [&_button]:text-sm!">
        <ExitConfirmation
            count={ungraded}
            onReview={() => {
                confirmExit = false;
                reviewing = true;
            }}
            onDiscard={() => act(() => exit(true))}
        />
    </div>{/if}
