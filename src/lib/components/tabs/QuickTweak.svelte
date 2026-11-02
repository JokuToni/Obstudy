<script lang="ts">
    import { onMount, tick } from "svelte";
    import type { PracticeSettings, StudyMode } from "$lib/types";
    import type { SyncedNote } from "$lib/types/notes";
    import TopicSelector from "$lib/components/practice/TopicSelector.svelte";
    import { selectedDifficulties } from "$lib/exercises/selection";
    import {
        button,
        input,
        focusRing,
        primaryButton,
    } from "$lib/components/ui/styles";

    let {
        note,
        settings,
        studyMode,
        onChange,
        onClose,
        onStart,
        startDisabledReason,
    }: {
        note: SyncedNote;
        settings: PracticeSettings;
        studyMode: StudyMode;
        onChange: (settings: PracticeSettings) => void;
        onClose: () => void;
        onStart: () => Promise<void>;
        startDisabledReason: string | null;
    } = $props();
    let dialog: HTMLDialogElement;
    let countInput: HTMLInputElement;
    const ignored = $derived(studyMode === "study");
    const difficulties = [
        { value: 0, label: "Easy" },
        { value: 1, label: "Medium" },
        { value: 2, label: "Hard" },
    ] as const;
    const formats = [
        { value: 2, label: "Mixed" },
        { value: 0, label: "Multiple choice" },
        { value: 1, label: "Freeform" },
    ] as const;
    const invalidCount = $derived(
        !Number.isInteger(settings.questionCount) ||
            settings.questionCount < 1 ||
            settings.questionCount > 1000,
    );
    function toggleDifficulty(level: 0 | 1 | 2): void {
        const current = selectedDifficulties(settings);
        const levels = current.includes(level)
            ? current.filter((item) => item !== level)
            : [...current, level].sort();
        if (levels.length)
            onChange({
                ...settings,
                difficulty: levels[0],
                difficulties: levels,
            });
    }
    onMount(() => {
        const trigger =
            document.activeElement instanceof HTMLButtonElement
                ? document.activeElement
                : document.getElementById("quick-tweak-trigger");
        dialog.show();
        countInput.focus();
        function keydown(event: KeyboardEvent): void {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
            } else if (event.key === "Tab") {
                const controls = Array.from(
                    dialog.querySelectorAll<HTMLElement>(
                        "button:not(:disabled), input:not(:disabled)",
                    ),
                );
                const first = controls[0];
                const last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        }
        dialog.addEventListener("keydown", keydown);
        return () => {
            dialog.removeEventListener("keydown", keydown);
            dialog.close();
            void tick().then(() => {
                if (trigger?.isConnected && !trigger.hasAttribute("disabled"))
                    trigger.focus({ preventScroll: true });
            });
        };
    });
</script>

<div
    data-quick-tweak-backdrop
    class="absolute inset-0 z-30 grid grid-rows-[minmax(0,1fr)] place-items-center overflow-hidden bg-scrim/60 p-3 sm:p-4"
>
    <dialog
        bind:this={dialog}
        id="quick-tweak-dialog"
        aria-labelledby="quick-tweak-title"
        oncancel={(event) => {
            event.preventDefault();
            onClose();
        }}
        class="relative inset-auto m-0 flex h-[min(34rem,100%)] max-h-full w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-lg border border-border bg-canvas p-4 text-text-primary shadow-xl"
    >
        <div class="flex shrink-0 items-center justify-between gap-3">
            <h2 id="quick-tweak-title" class="text-base font-semibold">
                Quick tweak
            </h2>
            <button type="button" class={button} onclick={onClose}>Close</button
            >
        </div>
        <div class="flex shrink-0 items-center justify-between gap-3">
            <label for="quick-question-count" class="text-[13px]/5 font-medium"
                >Number of questions</label
            >
            <input
                bind:this={countInput}
                id="quick-question-count"
                type="number"
                min="1"
                max="1000"
                step="1"
                required
                value={settings.questionCount}
                aria-invalid={invalidCount}
                aria-describedby={invalidCount
                    ? "quick-count-error"
                    : undefined}
                oninput={(event) =>
                    onChange({
                        ...settings,
                        questionCount: event.currentTarget.valueAsNumber,
                    })}
                class={[input, "w-24!"]}
            />
        </div>
        {#if invalidCount}<p
                id="quick-count-error"
                role="alert"
                class="text-xs/4 text-danger"
            >
                Enter a whole number from 1 to 1000.
            </p>{/if}
        {#if ignored}<p class="shrink-0 text-xs/4 text-text-muted">
                Study mode uses only the question count.
            </p>{/if}
        <div class="grid shrink-0 grid-cols-[1.1fr_1fr] gap-3">
            <fieldset
                disabled={ignored}
                class="shrink-0 space-y-1 disabled:opacity-60"
            >
                <legend class="text-[13px]/5 font-medium">Difficulties</legend>
                <div class="flex flex-wrap gap-x-2">
                    {#each difficulties as item}
                        <label
                            class="flex min-h-8 items-center gap-1 text-xs/5"
                        >
                            <input
                                type="checkbox"
                                checked={selectedDifficulties(
                                    settings,
                                ).includes(item.value)}
                                disabled={selectedDifficulties(settings)
                                    .length === 1 &&
                                    selectedDifficulties(settings).includes(
                                        item.value,
                                    )}
                                onchange={() => toggleDifficulty(item.value)}
                                class={[
                                    "size-3.5 accent-accent-solid",
                                    focusRing,
                                ]}
                            />{item.label}
                        </label>
                    {/each}
                </div>
            </fieldset>
            <fieldset
                disabled={ignored}
                class="shrink-0 space-y-1 disabled:opacity-60"
            >
                <legend class="text-[13px]/5 font-medium">Format</legend>
                <div class="flex gap-1">
                    {#each formats as item}<button
                            type="button"
                            aria-pressed={settings.questionFormat ===
                                item.value}
                            class={[
                                button,
                                "min-w-0 flex-1 px-1! text-xs!",
                                settings.questionFormat === item.value
                                    ? "bg-selected! text-accent!"
                                    : "",
                            ]}
                            onclick={() =>
                                onChange({
                                    ...settings,
                                    questionFormat: item.value,
                                })}>{item.label}</button
                        >{/each}
                </div>
            </fieldset>
        </div>
        <TopicSelector {note} {settings} disabled={ignored} {onChange} />
        <div
            class="flex shrink-0 items-center justify-end gap-3 border-t border-border pt-3"
        >
            {#if !ignored && settings.excludeAllTopics}<p
                    class="text-xs/4 text-text-muted"
                >
                    Include a topic to start.
                </p>{/if}
            {#if startDisabledReason}<p class="text-xs/4 text-text-muted">
                    {startDisabledReason}
                </p>{/if}
            <button
                type="button"
                class={[
                    primaryButton,
                    "min-h-8! shrink-0 px-3! py-1! text-xs!",
                ]}
                disabled={invalidCount ||
                    !!startDisabledReason ||
                    (!ignored && !!settings.excludeAllTopics)}
                onclick={() => {
                    void onStart();
                }}>Start session</button
            >
        </div>
    </dialog>
</div>
