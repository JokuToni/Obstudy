<script lang="ts">
    import { tick } from "svelte";
    import Overview from "./Overview.svelte";
    import NoteTab from "./NoteTab.svelte";
    import type { SyncedNote } from "$lib/types/notes";
    import PracticeSettings from "./PracticeSettings.svelte";
    import AiIntegrations from "./AiIntegrations.svelte";
    import Dropdown from "$lib/components/ui/Dropdown.svelte";
    import { focusRing, menuItem } from "$lib/components/ui/styles";
    import {
        workspaceTabs,
        tabLabel,
        shortTabLabel,
        noteTitle,
        type WorkspaceTab,
    } from "$lib/types/workspace";
    import type { AiConfiguration } from "$lib/types/ai";
    import type {
        StudyMode,
        PracticeSettings as PracticeSettingsValue,
    } from "$lib/types";
    import type {
        NoteGenerationState,
        QuestionGenerationRequest,
        NoteQuestionActionRequest,
    } from "$lib/types/questions";

    let {
        tabs,
        notes,
        activeTab,
        openTab,
        closeTab,
        aiConfiguration,
        aiLoading,
        aiError,
        onConfigurationChanged,
        noteGenerations,
        onGenerateQuestions,
        onManageQuestions,
        selectedNote,
        studyMode,
        onPracticeSettingsSaved,
        practiceSettings,
        onPracticeSettingsChange,
        noteWarning = null,
    }: {
        noteWarning?: string | null;
        tabs: WorkspaceTab[];
        notes: SyncedNote[];
        activeTab: WorkspaceTab;
        openTab: (tab: WorkspaceTab) => void;
        closeTab: (tab: WorkspaceTab) => void;
        aiConfiguration: AiConfiguration;
        aiLoading: boolean;
        aiError: string | null;
        onConfigurationChanged: () => Promise<void>;
        noteGenerations: Record<string, NoteGenerationState>;
        onGenerateQuestions: (
            request: QuestionGenerationRequest,
        ) => Promise<void>;
        onManageQuestions: (
            request: NoteQuestionActionRequest,
        ) => Promise<void>;
        selectedNote?: SyncedNote;
        studyMode: StudyMode;
        onPracticeSettingsSaved: (note: SyncedNote) => void;
        practiceSettings: PracticeSettingsValue;
        onPracticeSettingsChange: (
            noteId: string,
            settings: PracticeSettingsValue,
        ) => void;
    } = $props();
    const activeIntegration = $derived(
        aiConfiguration.integrations.find(
            (integration) =>
                integration.id === aiConfiguration.activeIntegrationId,
        ),
    );
    const generationDisabledReason = $derived(
        aiLoading
            ? "Loading AI integrations…"
            : aiError
              ? "AI integrations could not be loaded. Open AI integrations to try again."
              : !activeIntegration?.model
                ? "Select an AI integration and model before generating questions."
                : null,
    );
    async function navigateTabs(
        event: KeyboardEvent,
        tab: WorkspaceTab,
    ): Promise<void> {
        const index = tabs.indexOf(tab);
        let next: WorkspaceTab | undefined;
        if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
        else if (event.key === "ArrowLeft")
            next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === "Home") next = tabs[0];
        else if (event.key === "End") next = tabs[tabs.length - 1];
        else if (event.key === "Delete" && tab !== "overview") {
            closeTab(tab);
            await tick();
            document.getElementById(`tab-${activeTab}`)?.focus();
            return;
        }
        if (!next) return;
        event.preventDefault();
        openTab(next);
        await tick();
        document.getElementById(`tab-${next}`)?.focus();
    }
</script>

<div
    class={[
        "relative isolate flex min-h-0 flex-1 flex-col",
        activeTab === "overview"
            ? "bg-overview-gradient-end bg-overview-glows"
            : "bg-tab-content",
    ]}
>
    {#if activeTab === "overview"}
        <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-0 -z-10 bg-[url('/textures/overview-grain.svg')] bg-repeat opacity-[0.70] mix-blend-overlay"
        ></div>
    {/if}
    <div
        class="relative flex h-[26px] shrink-0 items-end before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[10%] before:bg-sidebar"
    >
        <div
            aria-hidden="true"
            class="h-full w-2 shrink-0 border-b border-border bg-sidebar"
        ></div>
        <div
            role="tablist"
            aria-label="Workspace tabs"
            class="flex h-full min-w-0 flex-1 items-end overflow-x-auto after:h-full after:min-w-0 after:flex-1 after:border-b after:border-border after:bg-sidebar"
        >
            {#each tabs as tab (tab)}
                <div
                    class={[
                        "flex h-[90%] shrink-0 items-center rounded-t-md border-x border-t",
                        activeTab === tab
                            ? "border-border"
                            : "border-x-sidebar border-t-sidebar border-b border-b-border bg-sidebar text-text-muted",
                    ]}
                >
                    <button
                        id={`tab-${tab}`}
                        type="button"
                        role="tab"
                        title={tabLabel(tab, notes)}
                        aria-label={tabLabel(tab, notes)}
                        aria-selected={activeTab === tab}
                        aria-controls={`panel-${tab}`}
                        tabindex={activeTab === tab ? 0 : -1}
                        onclick={() => openTab(tab)}
                        onkeydown={(event) => navigateTabs(event, tab)}
                        class={[
                            "h-full whitespace-nowrap rounded-t-md px-3 text-xs/4",
                            activeTab !== tab ? "hover:bg-hover" : "",
                            focusRing,
                        ]}>{shortTabLabel(tabLabel(tab, notes))}</button
                    >
                    {#if tab !== "overview"}
                        <button
                            type="button"
                            aria-label={`Close ${tabLabel(tab, notes)}`}
                            onclick={async () => {
                                closeTab(tab);
                                await tick();
                                document
                                    .getElementById(`tab-${activeTab}`)
                                    ?.focus();
                            }}
                            class={[
                                "mr-1 h-full w-5 rounded text-xs hover:bg-hover",
                                focusRing,
                            ]}>×</button
                        >
                    {/if}
                </div>
            {/each}
        </div>
        <div
            class="flex h-full shrink-0 items-end border-b border-border bg-sidebar pl-1 pr-2"
        >
            <Dropdown id="add-tab-options" label="+" compact>
                {#snippet children(close)}
                    <p class="px-3 py-2 text-xs text-text-muted">Open a tab</p>
                    {#each workspaceTabs as tab}
                        <button
                            type="button"
                            class={menuItem}
                            onclick={() => {
                                openTab(tab.id);
                                close();
                            }}
                            >{tab.label}{#if tabs.includes(tab.id)}<span
                                    class="ml-auto text-xs text-text-muted"
                                    >Open</span
                                >{/if}</button
                        >
                    {/each}
                    {#each notes.filter((note) => note.isAvailable && note.isStudying) as note (note.id)}
                        <button
                            type="button"
                            class={[menuItem, "min-w-0"]}
                            title={noteTitle(note)}
                            onclick={() => {
                                openTab(`note:${note.id}`);
                                close();
                            }}
                        >
                            <span class="truncate">{noteTitle(note)}</span>
                            {#if tabs.includes(`note:${note.id}`)}<span
                                    class="ml-auto text-xs text-text-muted"
                                    >Open</span
                                >{/if}
                        </button>
                    {/each}
                {/snippet}
            </Dropdown>
        </div>
    </div>
    <div data-tab-body class="relative flex min-h-0 flex-1 flex-col">
        <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {#if noteWarning}<p
                    role="status"
                    class="mb-4 rounded-md border border-border bg-surface px-3 py-2 text-xs/5 text-warning"
                >
                    {noteWarning}
                </p>{/if}
            {#each tabs as tab (tab)}
                <div
                    id={`panel-${tab}`}
                    role="tabpanel"
                    aria-labelledby={`tab-${tab}`}
                    tabindex="0"
                    hidden={activeTab !== tab}
                    class={focusRing}
                >
                    {#if tab === "overview"}<Overview />
                    {:else if tab.startsWith("note:")}
                        {@const note = notes.find(
                            (item) => item.id === tab.slice(5),
                        )}
                        {#if note}<NoteTab
                                {note}
                                isActive={activeTab === tab}
                                generation={noteGenerations[note.id]}
                                {generationDisabledReason}
                                onGenerate={onGenerateQuestions}
                                onManage={onManageQuestions}
                                onConfigureAi={() => openTab("ai")}
                            />{/if}
                    {:else if tab === "settings"}<PracticeSettings
                            note={selectedNote}
                            {studyMode}
                            settings={practiceSettings}
                            onChange={(settings) => {
                                if (selectedNote)
                                    onPracticeSettingsChange(
                                        selectedNote.id,
                                        settings,
                                    );
                            }}
                            onSaved={onPracticeSettingsSaved}
                        />
                    {:else}<AiIntegrations
                            configuration={aiConfiguration}
                            loading={aiLoading}
                            loadError={aiError}
                            {onConfigurationChanged}
                        />{/if}
                </div>
            {/each}
        </div>
    </div>
</div>
