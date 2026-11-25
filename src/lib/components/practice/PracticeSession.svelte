<script lang="ts">
    import { onMount } from "svelte";
    import { isTauri } from "@tauri-apps/api/core";
    import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
    import {
        loadExerciseSession,
        saveExerciseDraft,
        closeExerciseSession,
    } from "$lib/services/exercises";
    import { hasAnswer } from "$lib/drawing/answers";
    import { automaticGrade, gradeWithAi } from "$lib/grading/answers";
    import ExitConfirmation from "$study/components/practice/ExitConfirmation.svelte";
    import PracticeView from "$lib/views/PracticeView.svelte";
    import type {
        ExerciseDraftAnswer,
        ExerciseSession,
        AnswerGrade,
    } from "$lib/types/exercises";
    import { button } from "$lib/components/ui/styles";

    let { exerciseId }: { exerciseId: string } = $props();
    let session = $state<ExerciseSession | null>(null);
    let answers = $state<ExerciseDraftAnswer[]>([]);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let errorMessage = $state<string | null>(null);
    let saving = $state(false);
    let closing = $state(false);
    let confirmExit = $state(false);
    let reviewRequest = $state(0);
    let grading = $state<Record<string, boolean>>({});
    let gradingErrors = $state<Record<string, string | null>>({});
    let gradingEpoch = 0;
    const ungradedCount = $derived(
        answers.filter((answer) => hasAnswer(answer) && !answer.grade).length,
    );
    let revision = 0;
    let editVersion = 0;
    let savedVersion = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingSave: Promise<void> = Promise.resolve();
    function errorText(error: unknown): string {
        return typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : typeof error === "object" &&
                  error &&
                  "message" in error &&
                  typeof error.message === "string"
                ? error.message
                : "Unable to save this session. Please try again.";
    }
    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        try {
            const loaded = await loadExerciseSession(exerciseId);
            if (!loaded.questions.length)
                throw new Error("This session has no questions.");
            session = loaded;
            answers = loaded.draftAnswers.map((answer) => {
                const question = loaded.questions.find(
                    (question) => question.id === answer.questionId,
                );
                return question
                    ? {
                          ...answer,
                          grade:
                              automaticGrade(question, answer) ?? answer.grade,
                      }
                    : answer;
            });
            revision = loaded.revision;
            editVersion =
                answers.some(
                    (answer, index) =>
                        answer.grade && !loaded.draftAnswers[index].grade,
                ) || !!loaded.pendingReviewQuestionIds?.length
                    ? 1
                    : 0;
            savedVersion = 0;
            if (editVersion) void flush().catch(() => {});
        } catch (error) {
            loadError = errorText(error);
        } finally {
            loading = false;
        }
    }
    function flush(finish = false): Promise<void> {
        clearTimeout(debounceTimer);
        const save = async () => {
            if (
                !session ||
                session.closedAt ||
                (editVersion === savedVersion && !finish)
            )
                return;
            const savingVersion = editVersion;
            const snapshot = answers.map((answer) => ({ ...answer }));
            saving = true;
            try {
                const result = await saveExerciseDraft(
                    exerciseId,
                    revision,
                    snapshot,
                    finish,
                );
                revision = result.revision;
                savedVersion = savingVersion;
                session = {
                    ...session,
                    revision,
                    scheduledQuestionIds: result.scheduledQuestionIds,
                    pendingReviewQuestionIds: result.pendingReviewQuestionIds,
                    reviewedAt: result.reviewedAt,
                    draftAnswers: snapshot,
                };
                errorMessage = null;
            } catch (error) {
                errorMessage = errorText(error);
                throw error;
            } finally {
                saving = editVersion !== savedVersion && !errorMessage;
            }
        };
        const next = pendingSave.catch(() => {}).then(save);
        pendingSave = next;
        return next;
    }
    function change(answer: ExerciseDraftAnswer): void {
        if (closing || session?.closedAt) return;
        const question = session?.questions.find(
            (question) => question.id === answer.questionId,
        );
        if (question)
            answer = {
                ...answer,
                grade: automaticGrade(question, answer) ?? answer.grade,
            };
        answers = [
            ...answers.filter((item) => item.questionId !== answer.questionId),
            answer,
        ];
        editVersion++;
        saving = true;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(
            () => {
                void flush().catch(() => {});
            },
            answer.revealed ? 0 : 300,
        );
    }
    async function finish(): Promise<void> {
        await flush(true).catch(() => {});
    }
    async function retrySave(): Promise<void> {
        await flush().catch(() => {});
    }
    function gradeAnswer(questionId: string, grade: AnswerGrade): void {
        const answer = answers.find(
            (answer) => answer.questionId === questionId,
        );
        if (
            !answer?.revealed ||
            (session?.mode === "study" &&
                session.scheduledQuestionIds?.includes(questionId))
        )
            return;
        gradingErrors[questionId] = null;
        change({ ...answer, grade });
    }
    async function aiGrade(questionId: string): Promise<void> {
        if (closing || session?.closedAt || grading[questionId]) return;
        const question = session?.questions.find(
            (question) => question.id === questionId,
        );
        const answer = answers.find(
            (answer) => answer.questionId === questionId,
        );
        if (!question || !answer?.revealed) return;
        const epoch = gradingEpoch;
        grading[questionId] = true;
        gradingErrors[questionId] = null;
        try {
            const grade = await gradeWithAi(question, { ...answer });
            if (
                epoch === gradingEpoch &&
                !session?.closedAt &&
                !answers.find((answer) => answer.questionId === questionId)
                    ?.grade
            )
                gradeAnswer(questionId, grade);
        } catch (error) {
            if (epoch === gradingEpoch)
                gradingErrors[questionId] = errorText(error);
        } finally {
            grading[questionId] = false;
        }
    }
    async function close(voidUngraded = false): Promise<void> {
        if (closing) return;
        if (ungradedCount && !voidUngraded && !session?.closedAt) {
            confirmExit = true;
            return;
        }
        confirmExit = false;
        closing = true;
        gradingEpoch++;
        try {
            await flush();
            if (session && !session.closedAt) {
                session = await closeExerciseSession(
                    exerciseId,
                    revision,
                    voidUngraded,
                );
                revision = session.revision;
                answers = session.draftAnswers;
            }
            if (isTauri()) await getCurrentWebviewWindow().destroy();
            else window.close();
        } catch (error) {
            errorMessage = errorText(error);
        } finally {
            closing = false;
        }
    }
    onMount(() => {
        void load();
        let disposed = false;
        let stopListening: (() => void) | undefined;
        if (isTauri()) {
            void getCurrentWebviewWindow()
                .onCloseRequested((event) => {
                    event.preventDefault();
                    void close();
                })
                .then((unlisten) => {
                    if (disposed) unlisten();
                    else stopListening = unlisten;
                });
        }
        return () => {
            disposed = true;
            clearTimeout(debounceTimer);
            stopListening?.();
        };
    });
</script>

{#if loading}<main
        class="flex min-h-dvh items-center justify-center bg-canvas p-6 text-text-secondary"
    >
        <p role="status" class="text-sm">Preparing your session…</p>
    </main>
{:else if loadError}<main
        class="flex min-h-dvh items-center justify-center bg-canvas p-6 text-text-primary"
    >
        <div class="max-w-md space-y-4">
            <h1 class="text-base font-semibold">Unable to open session</h1>
            <p role="alert" class="text-sm/6 text-danger">{loadError}</p>
            <div class="flex gap-2">
                <button type="button" class={button} onclick={load}
                    >Try again</button
                ><button type="button" class={button} onclick={() => close()}
                    >Close</button
                >
            </div>
        </div>
    </main>
{:else if session}<PracticeView
        {session}
        {answers}
        {saving}
        {closing}
        {errorMessage}
        onChange={change}
        onFinish={finish}
        onClose={() => close()}
        onRetrySave={retrySave}
        {reviewRequest}
        {grading}
        {gradingErrors}
        onGrade={gradeAnswer}
        onAiGrade={aiGrade}
    />{/if}

{#if confirmExit}<ExitConfirmation
        count={ungradedCount}
        onReview={() => {
            confirmExit = false;
            reviewRequest++;
        }}
        onDiscard={() => {
            void close(true);
        }}
    />{/if}
