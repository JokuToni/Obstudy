<script lang="ts">
    import { onMount, tick } from "svelte";
    import type { PracticeSettings, StudyMode } from "$lib/types";
    import type { SyncedNote } from "$lib/types/notes";
    import { selectedDifficulties } from "$lib/exercises/selection";
    import { button, input, focusRing } from "$lib/components/ui/styles";

    let {
        note,
        settings,
        studyMode,
        onChange,
        onClose,
    }: {
        note: SyncedNote;
        settings: PracticeSettings;
        studyMode: StudyMode;
        onChange: (settings: PracticeSettings) => void;
        onClose: () => void;
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
    // Show subtopics and standalone broad topics. Selecting an entire group
    // also includes its broad topic, preserving existing question filtering.
    const topics = $derived(
        note.topics.filter(
            (topic) =>
                "text" in topic ||
                !note.topics.some(
                    (child) =>
                        "broadTopicId" in child &&
                        child.broadTopicId === topic.id,
                ),
        ),
    );
    const included = $derived(
        topics.filter(
            (topic) =>
                !settings.topicIds.length ||
                settings.topicIds.includes(topic.id) ||
                ("broadTopicId" in topic &&
                    !!topic.broadTopicId &&
                    settings.topicIds.includes(topic.broadTopicId)),
        ),
    );
    const excluded = $derived(
        topics.filter(
            (topic) => !included.some((item) => item.id === topic.id),
        ),
    );
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
    async function moveTopic(topicId: string, include: boolean): Promise<void> {
        const ids = new Set(included.map((topic) => topic.id));
        if (include) ids.add(topicId);
        else ids.delete(topicId);
        // Empty topicIds means all topics throughout the existing app.
        if (!ids.size) return;
        for (const parent of note.topics.filter(
            (topic) => !("text" in topic),
        )) {
            const children = topics.filter(
                (topic) =>
                    "broadTopicId" in topic && topic.broadTopicId === parent.id,
            );
            if (children.length && children.every((topic) => ids.has(topic.id)))
                ids.add(parent.id);
        }
        onChange({
            ...settings,
            topicIds: topics.every((topic) => ids.has(topic.id))
                ? []
                : [...ids],
        });
        await tick();
        dialog
            .querySelector<HTMLButtonElement>(
                `[data-topic-id="${CSS.escape(topicId)}"]`,
            )
            ?.focus();
    }
    onMount(() => {
        const trigger = document.getElementById("quick-tweak-trigger");
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
        aria-labelledby="quick-tweak-title"
        oncancel={(event) => {
            event.preventDefault();
            onClose();
        }}
        class="relative inset-auto m-0 flex max-h-full w-full max-w-xl flex-col gap-3 overflow-hidden rounded-lg border border-border bg-canvas p-4 text-text-primary shadow-xl"
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
        <fieldset
            disabled={ignored}
            class="shrink-0 space-y-1 disabled:opacity-60"
        >
            <legend class="text-[13px]/5 font-medium">Difficulties</legend>
            <div class="flex gap-2">
                {#each difficulties as item}
                    <label
                        class="flex min-h-8 items-center gap-2 text-[13px]/5"
                    >
                        <input
                            type="checkbox"
                            checked={selectedDifficulties(settings).includes(
                                item.value,
                            )}
                            disabled={selectedDifficulties(settings).length ===
                                1 &&
                                selectedDifficulties(settings).includes(
                                    item.value,
                                )}
                            onchange={() => toggleDifficulty(item.value)}
                            class={["size-4 accent-accent-solid", focusRing]}
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
            <div class="flex gap-2">
                {#each formats as item}<button
                        type="button"
                        aria-pressed={settings.questionFormat === item.value}
                        class={[
                            button,
                            "min-w-0 flex-1 px-2!",
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
        <fieldset
            disabled={ignored}
            class="flex min-h-0 flex-col gap-2 disabled:opacity-60"
        >
            <legend class="mb-1 text-[13px]/5 font-medium">Topics</legend>
            <div class="grid min-h-0 grid-cols-2 gap-2">
                {#each [{ label: "Included", items: included, include: false }, { label: "Excluded", items: excluded, include: true }] as column}
                    <section
                        aria-label={`${column.label} topics`}
                        class="flex min-h-0 flex-col rounded-md border border-border bg-surface"
                    >
                        <h3
                            class="shrink-0 border-b border-border px-2 py-1 text-xs/5 font-medium"
                        >
                            {column.label}
                            <span class="text-text-muted"
                                >{column.items.length}</span
                            >
                        </h3>
                        <div class="h-32 min-h-0 overflow-y-auto p-1">
                            {#each column.items as topic (topic.id)}
                                <button
                                    type="button"
                                    data-topic-id={topic.id}
                                    aria-label={`${column.include ? "Include" : "Exclude"} ${topic.title}`}
                                    title={!column.include &&
                                    included.length === 1
                                        ? "Keep at least one topic included."
                                        : topic.title}
                                    disabled={!column.include &&
                                        included.length === 1}
                                    onclick={() =>
                                        moveTopic(topic.id, column.include)}
                                    class={[
                                        "flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs/5 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60",
                                        focusRing,
                                    ]}
                                >
                                    <span class="min-w-0 flex-1 truncate"
                                        >{topic.title}</span
                                    ><span
                                        aria-hidden="true"
                                        class="text-text-muted"
                                        >{column.include ? "←" : "→"}</span
                                    >
                                </button>
                            {:else}<p class="p-2 text-xs/5 text-text-muted">
                                    {topics.length ? "None" : "No topics yet"}
                                </p>{/each}
                        </div>
                    </section>
                {/each}
            </div>
        </fieldset>
    </dialog>
</div>
