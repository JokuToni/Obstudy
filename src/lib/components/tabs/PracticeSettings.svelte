<script lang="ts">
    import type { PracticeSettings, StudyMode } from "$lib/types";
    import type { SyncedNote } from "$lib/types/notes";
    import { savePracticeSettings } from "$lib/services/exercises";
    import { selectedDifficulties } from "$lib/exercises/selection";
    import { noteTitle } from "$lib/types/workspace";
    import Dropdown from "$lib/components/ui/Dropdown.svelte";
    import {
        focusRing,
        input,
        menuItem,
        primaryButton,
    } from "$lib/components/ui/styles";
    let {
        note,
        studyMode,
        onSaved,
        settings,
        onChange,
    }: {
        note?: SyncedNote;
        studyMode: StudyMode;
        onSaved: (note: SyncedNote) => void;
        settings: PracticeSettings;
        onChange: (settings: PracticeSettings) => void;
    } = $props();
    let loadedKey = "";
    let busy = $state(false);
    let errorMessage = $state<string | null>(null);
    let saved = $state(false);
    let savedSettingsKey = "";
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
    const ignored = $derived(studyMode === "study");
    $effect(() => {
        const key = JSON.stringify([note?.id, note?.savedPracticeSettings]);
        if (key !== loadedKey) {
            loadedKey = key;
            errorMessage = null;
            saved = key === savedSettingsKey;
        }
    });
    function change(updated: PracticeSettings): void {
        saved = false;
        onChange(updated);
    }
    function toggleTopic(topicId: string): void {
        change({
            ...settings,
            topicIds: settings.topicIds.includes(topicId)
                ? settings.topicIds.filter((id) => id !== topicId)
                : [...settings.topicIds, topicId],
        });
    }
    function toggleDifficulty(level: 0 | 1 | 2): void {
        const selected = selectedDifficulties(settings);
        const levels = selected.includes(level)
            ? selected.filter((value) => value !== level)
            : [...selected, level].sort();
        if (levels.length)
            change({
                ...settings,
                difficulty: levels[0],
                difficulties: levels,
            });
    }
    async function save(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (!note || busy) return;
        busy = true;
        errorMessage = null;
        try {
            const updated = await savePracticeSettings(note.id, settings);
            savedSettingsKey = JSON.stringify([
                updated.id,
                updated.savedPracticeSettings,
            ]);
            onSaved(updated);
            saved = true;
        } catch (error) {
            errorMessage =
                typeof error === "string"
                    ? error
                    : error instanceof Error
                      ? error.message
                      : "Unable to save practice settings.";
        } finally {
            busy = false;
        }
    }
</script>

<section class="max-w-2xl space-y-6" aria-labelledby="settings-heading">
    <div>
        <h2 id="settings-heading" class="text-[22px]/[30px] font-semibold">
            Practice settings
        </h2>
        <p class="mt-2 text-sm/5 text-text-secondary">
            {note
                ? `Session options for ${noteTitle(note)}.`
                : "Select a Studying note to configure its sessions."}
        </p>
        <p class="mt-2 text-xs/5 text-text-muted">
            Start uses the options shown here. Save settings to remember them
            for this note after restarting the app.
        </p>
    </div>
    {#if note}
        {#if ignored}<p
                class="rounded-md border border-border bg-surface p-3 text-xs/5 text-text-secondary"
            >
                Study uses basic questions due today, in schedule order. Only
                the question limit applies; difficulty, format, reuse, and topic
                filters are ignored.
            </p>{/if}
        <form
            onsubmit={save}
            oninput={() => {
                saved = false;
            }}
            class="space-y-6"
        >
            <fieldset disabled={busy} class="space-y-6">
                <legend class="sr-only">Session options</legend>
                <div class="space-y-2">
                    <label for="session-count" class="block text-sm font-medium"
                        >Number of questions</label
                    ><input
                        id="session-count"
                        type="number"
                        min="1"
                        max="1000"
                        step="1"
                        required
                        value={settings.questionCount}
                        oninput={(event) =>
                            change({
                                ...settings,
                                questionCount:
                                    event.currentTarget.valueAsNumber,
                            })}
                        class={input}
                    />
                    <p class="text-xs/5 text-text-muted">
                        The session can be shorter when fewer questions are
                        available.
                    </p>
                </div>
                <div class="grid gap-4 sm:grid-cols-2">
                    <fieldset disabled={ignored || busy} class="space-y-3">
                        <legend class="text-sm font-medium">Difficulties</legend
                        >
                        <div class="flex flex-wrap gap-4">
                            {#each difficulties as item}
                                <label class="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={selectedDifficulties(
                                            settings,
                                        ).includes(item.value)}
                                        disabled={selectedDifficulties(settings)
                                            .length === 1 &&
                                            selectedDifficulties(
                                                settings,
                                            ).includes(item.value)}
                                        onchange={() =>
                                            toggleDifficulty(item.value)}
                                        class={[
                                            "size-4 accent-accent-solid",
                                            focusRing,
                                        ]}
                                    />
                                    {item.label}
                                </label>
                            {/each}
                        </div>
                        <p class="text-xs/5 text-text-muted">
                            Choose one or more levels. Fresh questions are split
                            evenly across them, within the total question count.
                        </p>
                    </fieldset>
                    <div class="space-y-2">
                        <span
                            id="session-format-label"
                            class="block text-sm font-medium"
                            >Question format</span
                        ><Dropdown
                            id="session-format"
                            label={formats.find(
                                (item) =>
                                    item.value === settings.questionFormat,
                            )!.label}
                            labelledBy="session-format-label"
                            disabled={ignored || busy}
                            fullWidth
                            >{#snippet children(
                                close,
                            )}{#each formats as item}<button
                                        type="button"
                                        class={menuItem}
                                        aria-pressed={settings.questionFormat ===
                                            item.value}
                                        onclick={() => {
                                            change({
                                                ...settings,
                                                questionFormat: item.value,
                                            });
                                            close();
                                        }}>{item.label}</button
                                    >{/each}{/snippet}</Dropdown
                        >
                    </div>
                </div>
                <div class="space-y-2">
                    <label class="flex items-center gap-2 text-sm"
                        ><input
                            type="checkbox"
                            checked={settings.reuseQuestions}
                            onchange={(event) =>
                                change({
                                    ...settings,
                                    reuseQuestions: event.currentTarget.checked,
                                })}
                            disabled={ignored}
                            class={["size-4 accent-accent-solid", focusRing]}
                        />Reuse saved questions</label
                    >
                    <p class="text-xs/5 text-text-muted">
                        Turn off to generate fresh practice questions using your
                        selected AI integration.
                    </p>
                </div>
                <fieldset
                    disabled={ignored || busy}
                    class="space-y-3 border-t border-border pt-4"
                >
                    <legend class="text-sm font-medium">Topics</legend>
                    <p class="text-xs/5 text-text-muted">
                        Leave all unchecked to use every topic.
                    </p>
                    <div class="max-h-64 space-y-2 overflow-y-auto">
                        {#each note.topics as topic (topic.id)}<label
                                class={[
                                    "flex items-start gap-2 text-[13px]/5",
                                    "text" in topic
                                        ? "pl-4 text-text-secondary"
                                        : "font-medium",
                                ]}
                                ><input
                                    type="checkbox"
                                    checked={settings.topicIds.includes(
                                        topic.id,
                                    )}
                                    onchange={() => toggleTopic(topic.id)}
                                    class={[
                                        "mt-1 size-4 shrink-0 accent-accent-solid",
                                        focusRing,
                                    ]}
                                /><span>{topic.title}</span></label
                            >{/each}
                    </div>
                </fieldset>
            </fieldset>
            <button type="submit" class={primaryButton} disabled={busy}
                >{busy ? "Saving…" : "Save settings"}</button
            >
        </form>
        {#if errorMessage}<p role="alert" class="text-sm text-danger">
                {errorMessage}
            </p>{/if}
        {#if saved}<p role="status" class="text-xs/5 text-text-secondary">
                Session settings saved.
            </p>{/if}
    {/if}
</section>
