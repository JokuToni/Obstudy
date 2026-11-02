<script lang="ts">
    import { setNoteStudying } from "$lib/services/notes";
    import ReviewNoteChanges from "$lib/components/notes/ReviewNoteChanges.svelte";
    import type { NoteSyncResult, SyncedNote } from "$lib/types/notes";
    import { onMount } from "svelte";
    import { invoke, isTauri } from "@tauri-apps/api/core";
    import { listen } from "@tauri-apps/api/event";
    import { getNotesFolderPath } from "$lib/services/settings";
    import NotesPanel from "$lib/components/notes/NotesPanel.svelte";
    import TabPanel from "$lib/components/tabs/TabPanel.svelte";
    import BottomBar from "$lib/components/BottomBar.svelte";
    import { getAiConfiguration, selectAiIntegration } from "$lib/services/ai";
    import type { AiConfiguration } from "$lib/types/ai";
    import type { WorkspaceTab } from "$lib/types/workspace";
    import type { PracticeSettings, StudyMode } from "$lib/types";
    import {
        createExercise,
        openPracticeWindow,
    } from "$lib/services/exercises";
    import {
        defaultPracticeSettings,
        effectiveExerciseSettings,
    } from "$lib/exercises/selection";
    import type { ExerciseSession } from "$lib/types/exercises";
    import {
        generateQuestions,
        QuestionGenerationError,
        manageNoteQuestions,
    } from "$lib/services/questions";
    import type {
        NoteGenerationState,
        QuestionGenerationRequest,
        QuestionGenerationResult,
        NoteQuestionActionRequest,
    } from "$lib/types/questions";

    let { noteSync = $bindable() }: { noteSync: NoteSyncResult } = $props();
    let selectedNoteId = $state<string | null>(null);
    let reviewingChanges = $state(false);
    let reviewNoteId = $state<string | null>(null);
    const reviewNote = $derived(
        noteSync.notes.find((note) => note.id === reviewNoteId),
    );
    let movingNoteId = $state<string | null>(null);
    let moveError = $state<string | null>(null);
    const selectedNote = $derived(
        noteSync.notes.find((note) => note.id === selectedNoteId),
    );
    function selectNote(note: SyncedNote): void {
        if (note.isStudying) openTab(`note:${note.id}`);
        reviewNoteId = note.id;
        reviewingChanges = note.syncIssues.length > 0;
    }
    async function moveNote(
        noteId: string,
        isStudying: boolean,
    ): Promise<void> {
        if (movingNoteId) return;
        const note = noteSync.notes.find(
            (item) => item.id === noteId && item.isAvailable,
        );
        if (!note || note.isStudying === isStudying) return;
        movingNoteId = noteId;
        moveError = null;
        try {
            await setNoteStudying(noteId, isStudying);
            noteSync = {
                ...noteSync,
                notes: noteSync.notes.map((item) =>
                    item.id === noteId ? { ...item, isStudying } : item,
                ),
            };
            if (!isStudying) {
                closeTab(`note:${noteId}`);
                if (selectedNoteId === noteId) selectedNoteId = null;
            }
        } catch {
            moveError = "Unable to move the note. Try again.";
        } finally {
            movingNoteId = null;
        }
    }
    function updateNotes(result: NoteSyncResult): void {
        noteSync = { ...result, warnings: noteSync.warnings };
    }
    let tabs = $state<WorkspaceTab[]>(["overview"]);
    let activeTab = $state<WorkspaceTab>("overview");
    let studyMode = $state<StudyMode>("study");
    let aiConfiguration = $state<AiConfiguration>({
        integrations: [],
        activeIntegrationId: null,
    });
    let aiLoading = $state(true);
    let aiSelecting = $state(false);
    let aiError = $state<string | null>(null);
    let noteGenerations = $state<Record<string, NoteGenerationState>>({});
    let starting = $state(false);
    let quickTweakOpen = $state(false);
    $effect(() => {
        if (starting) quickTweakOpen = false;
    });
    let practiceDrafts = $state<Record<string, PracticeSettings>>({});
    const currentPracticeSettings = $derived(
        selectedNote
            ? (practiceDrafts[selectedNote.id] ??
                  selectedNote.savedPracticeSettings ??
                  defaultPracticeSettings)
            : defaultPracticeSettings,
    );
    function changePracticeSettings(
        noteId: string,
        settings: PracticeSettings,
    ): void {
        practiceDrafts[noteId] = {
            ...settings,
            topicIds: [...settings.topicIds],
        };
    }
    let startError = $state<string | null>(null);
    let preparedSession: ExerciseSession | null = null;
    let preparedKey = "";
    const startDisabledReason = $derived(
        !selectedNote
            ? "Select a Studying note to start a session."
            : noteGenerations[selectedNote.id]?.isGenerating ||
                noteGenerations[selectedNote.id]?.maintenanceAction
              ? "Wait for this note's question updates to finish."
              : null,
    );
    function updatePracticeSettings(note: SyncedNote): void {
        noteSync = {
            ...noteSync,
            notes: noteSync.notes.map((item) =>
                item.id === note.id
                    ? {
                          ...item,
                          savedPracticeSettings: note.savedPracticeSettings,
                      }
                    : item,
            ),
        };
    }
    let progressError = $state<string | null>(null);
    const progressRequests = new Map<string, number>();
    async function refreshNoteProgress(noteId?: string): Promise<void> {
        const ids = noteId
            ? [noteId]
            : [
                  ...new Set([
                      ...(selectedNoteId ? [selectedNoteId] : []),
                      ...tabs
                          .filter((tab) => tab.startsWith("note:"))
                          .map((tab) => tab.slice(5)),
                  ]),
              ];
        if (!ids.length) return;
        let folderPath: string | null;
        try {
            folderPath = await getNotesFolderPath();
        } catch {
            progressError =
                "Unable to refresh answer statistics. Return to this window to try again.";
            return;
        }
        if (!folderPath) return;
        await Promise.all(
            ids
                .filter((id) => noteSync.notes.some((note) => note.id === id))
                .map(async (id) => {
                    const request = (progressRequests.get(id) ?? 0) + 1;
                    progressRequests.set(id, request);
                    try {
                        const updated = await invoke<SyncedNote>(
                            "get_question_generation_note",
                            { folderPath, noteId: id },
                        );
                        if (progressRequests.get(id) !== request) return;
                        const questions = new Map(
                            updated.questions.map((question) => [
                                question.id,
                                question,
                            ]),
                        );
                        noteSync = {
                            ...noteSync,
                            notes: noteSync.notes.map((note) =>
                                note.id === id
                                    ? {
                                          ...note,
                                          answers: updated.answers,
                                          performances: updated.performances,
                                          exercises: updated.exercises,
                                          questions: note.questions.map(
                                              (question) => {
                                                  const saved = questions.get(
                                                      question.id,
                                                  );
                                                  return saved
                                                      ? {
                                                            ...question,
                                                            lastAnsweredAt:
                                                                saved.lastAnsweredAt,
                                                            averageScore:
                                                                saved.averageScore,
                                                        }
                                                      : question;
                                              },
                                          ),
                                      }
                                    : note,
                            ),
                        };
                        progressError = null;
                    } catch {
                        progressError =
                            "Unable to refresh answer statistics. Return to this window to try again.";
                    }
                }),
        );
    }
    async function startSession(): Promise<void> {
        if (starting || !selectedNote || startDisabledReason) return;
        const note = selectedNote;
        const mode = studyMode;
        const settings = {
            ...currentPracticeSettings,
            topicIds: [...currentPracticeSettings.topicIds],
        };
        const key = JSON.stringify([
            note.id,
            mode,
            effectiveExerciseSettings(settings, mode),
        ]);
        starting = true;
        startError = null;
        try {
            if (!preparedSession || preparedKey !== key) {
                preparedSession = await createExercise(
                    settings,
                    note.id,
                    mode,
                    updateGeneratedNote,
                );
                preparedKey = key;
                const session = preparedSession;
                noteSync = {
                    ...noteSync,
                    notes: noteSync.notes.map((item) =>
                        item.id === note.id
                            ? {
                                  ...item,
                                  exercises: [...item.exercises, session],
                              }
                            : item,
                    ),
                };
            }
            await openPracticeWindow(preparedSession.id);
            preparedSession = null;
        } catch (error) {
            if (error instanceof QuestionGenerationError)
                updateGeneratedNote(error.result.note);
            startError =
                typeof error === "string"
                    ? error
                    : error instanceof Error
                      ? error.message
                      : "Unable to start the session. Please try again.";
        } finally {
            starting = false;
        }
    }

    function updateGeneratedNote(
        note: SyncedNote,
        includeSyncIssues = false,
    ): void {
        // Preserve other workspace changes made while an AI request was running.
        noteSync = {
            ...noteSync,
            notes: noteSync.notes.map((item) =>
                item.id === note.id
                    ? {
                          ...item,
                          questions: note.questions,
                          questionFsrs: note.questionFsrs,
                          ...(includeSyncIssues
                              ? { syncIssues: note.syncIssues }
                              : {}),
                      }
                    : item,
            ),
        };
    }
    function finishGeneration(
        request: QuestionGenerationRequest,
        result: QuestionGenerationResult,
        error: string | null = null,
    ): void {
        updateGeneratedNote(result.note);
        const remainingCount = result.requestedCount - result.generatedCount;
        noteGenerations[request.noteId] = {
            isGenerating: false,
            progress: {
                mode: result.mode,
                generatedCount: result.generatedCount,
                requestedCount: result.requestedCount,
            },
            error,
            message: error
                ? null
                : result.complete
                  ? `Generated ${result.generatedCount} ${result.mode} questions.`
                  : `Saved ${result.generatedCount} of ${result.requestedCount} questions. Generate again to continue.`,
            warnings: [...new Set(result.warnings)],
            remainingRequest:
                remainingCount > 0 && result.mode === "additional"
                    ? { ...request, questionCount: remainingCount }
                    : null,
        };
    }
    async function startQuestionGeneration(
        request: QuestionGenerationRequest,
    ): Promise<void> {
        if (
            noteGenerations[request.noteId]?.isGenerating ||
            noteGenerations[request.noteId]?.maintenanceAction
        )
            return;
        noteGenerations[request.noteId] = {
            isGenerating: true,
            progress: null,
            message: null,
            error: null,
            warnings: [],
            remainingRequest: null,
        };
        try {
            const result = await generateQuestions(
                request.questionCount,
                request.noteId,
                request.topicIds,
                request.questionFormat,
                request.difficulty,
                {
                    onProgress: (progress) => {
                        noteGenerations[request.noteId] = {
                            ...noteGenerations[request.noteId],
                            progress,
                        };
                    },
                    onNoteUpdated: updateGeneratedNote,
                },
            );
            finishGeneration(request, result);
        } catch (error) {
            const message =
                error &&
                typeof error === "object" &&
                "message" in error &&
                typeof error.message === "string"
                    ? error.message
                    : typeof error === "string"
                      ? error
                      : "Unable to generate questions. Please try again.";
            if (error instanceof QuestionGenerationError) {
                finishGeneration(request, error.result, message);
                noteGenerations[request.noteId].errorDetails = error.details;
            } else
                noteGenerations[request.noteId] = {
                    ...noteGenerations[request.noteId],
                    isGenerating: false,
                    error: message,
                };
        }
    }

    async function manageQuestions(
        request: NoteQuestionActionRequest,
    ): Promise<void> {
        if (
            noteGenerations[request.noteId]?.isGenerating ||
            noteGenerations[request.noteId]?.maintenanceAction
        )
            return;
        noteGenerations[request.noteId] = {
            isGenerating: false,
            maintenanceAction: request.action,
            progress: null,
            message: null,
            error: null,
            warnings: [],
            remainingRequest: null,
        };
        try {
            const updated = await manageNoteQuestions(request);
            updateGeneratedNote(updated, true);
            noteGenerations[request.noteId] = {
                isGenerating: false,
                progress: null,
                error: null,
                warnings: [],
                remainingRequest: null,
                message:
                    request.action === "remove"
                        ? "Questions removed. Past answers and results are preserved."
                        : "Study schedule reset. Basic questions are ready to study again.",
            };
        } catch (error) {
            noteGenerations[request.noteId] = {
                ...noteGenerations[request.noteId],
                maintenanceAction: undefined,
                error:
                    typeof error === "string"
                        ? error
                        : error instanceof Error
                          ? error.message
                          : "Unable to update questions. Please try again.",
            };
        }
    }

    function openTab(tab: WorkspaceTab): void {
        if (!tabs.includes(tab)) tabs = [...tabs, tab];
        activeTab = tab;
        if (tab.startsWith("note:")) selectedNoteId = tab.slice(5);
    }
    function closeTab(tab: WorkspaceTab): void {
        if (tab === "overview") return;
        const index = tabs.indexOf(tab);
        tabs = tabs.filter((item) => item !== tab);
        if (activeTab === tab)
            openTab(tabs[Math.max(0, index - 1)] ?? "overview");
    }
    async function refreshAiConfiguration(): Promise<void> {
        aiLoading = true;
        aiError = null;
        try {
            aiConfiguration = await getAiConfiguration();
        } catch (error) {
            aiError =
                error &&
                typeof error === "object" &&
                "message" in error &&
                typeof error.message === "string"
                    ? error.message
                    : "Unable to load AI integrations. Try again.";
        } finally {
            aiLoading = false;
        }
    }
    async function chooseIntegration(id: string): Promise<void> {
        if (aiSelecting) return;
        aiSelecting = true;
        aiError = null;
        try {
            await selectAiIntegration(id);
            aiConfiguration = { ...aiConfiguration, activeIntegrationId: id };
        } catch {
            aiError = "Unable to switch AI integration. Try again.";
        } finally {
            aiSelecting = false;
        }
    }
    onMount(() => {
        void refreshAiConfiguration();
        const onFocus = () => {
            void refreshNoteProgress();
        };
        window.addEventListener("focus", onFocus);
        let disposed = false;
        let stopListening: (() => void) | undefined;
        if (isTauri())
            void listen<{ noteId: string }>(
                "study-progress-updated",
                (event) => {
                    void refreshNoteProgress(event.payload.noteId);
                },
            )
                .then((unlisten) => {
                    if (disposed) unlisten();
                    else stopListening = unlisten;
                })
                .catch(() => {
                    progressError =
                        "Live statistics are unavailable. Return to this window to refresh them.";
                });
        return () => {
            disposed = true;
            window.removeEventListener("focus", onFocus);
            stopListening?.();
        };
    });
</script>

<section
    class="flex h-dvh min-h-0 flex-col bg-canvas text-text-primary"
    aria-label="Study workspace"
>
    <div class="flex min-h-0 flex-1">
        <NotesPanel
            notes={noteSync.notes}
            warnings={noteSync.warnings}
            {selectedNoteId}
            onSelect={selectNote}
            onMove={moveNote}
            {movingNoteId}
            {moveError}
        />
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <TabPanel
                noteWarning={progressError ??
                    (selectedNote
                        ? (selectedNote.parseError ??
                          selectedNote.parseWarnings.join(" "))
                        : null)}
                notes={noteSync.notes}
                {tabs}
                bind:quickTweakOpen
                onStartSession={startSession}
                {startDisabledReason}
                {activeTab}
                {openTab}
                {closeTab}
                {aiConfiguration}
                {aiLoading}
                {aiError}
                {noteGenerations}
                onGenerateQuestions={startQuestionGeneration}
                onManageQuestions={manageQuestions}
                {selectedNote}
                {studyMode}
                practiceSettings={currentPracticeSettings}
                onPracticeSettingsChange={changePracticeSettings}
                onPracticeSettingsSaved={updatePracticeSettings}
                onConfigurationChanged={refreshAiConfiguration}
            />
            <BottomBar
                {quickTweakOpen}
                quickTweakDisabled={!selectedNote || starting}
                onQuickTweak={() => {
                    quickTweakOpen = !quickTweakOpen;
                }}
                {starting}
                {startDisabledReason}
                {startError}
                onStart={async () => {
                    quickTweakOpen = true;
                }}
                {studyMode}
                onModeChange={(mode) => {
                    studyMode = mode;
                }}
                {aiConfiguration}
                {aiLoading}
                {aiSelecting}
                {aiError}
                onSelectIntegration={chooseIntegration}
                onManageIntegrations={() => openTab("ai")}
                onRetry={refreshAiConfiguration}
            />
        </div>
    </div>
</section>

{#if reviewingChanges && reviewNote && reviewNote.syncIssues.length}
    <ReviewNoteChanges
        note={reviewNote}
        onResolved={updateNotes}
        onClose={() => {
            reviewingChanges = false;
        }}
    />
{/if}
