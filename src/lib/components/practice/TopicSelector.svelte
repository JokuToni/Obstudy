<script lang="ts">
    import { tick } from "svelte";
    import type { PracticeSettings } from "$lib/types";
    import type { SyncedNote } from "$lib/types/notes";
    import {
        includedBroadTopics,
        withBroadTopics,
    } from "$lib/exercises/topics";
    import { button, focusRing } from "$lib/components/ui/styles";

    let {
        note,
        settings,
        disabled = false,
        onChange,
    }: {
        note: SyncedNote;
        settings: PracticeSettings;
        disabled?: boolean;
        onChange: (settings: PracticeSettings) => void;
    } = $props();
    let root: HTMLFieldSetElement;
    const topics = $derived(note.topics.filter((topic) => !("text" in topic)));
    const included = $derived(includedBroadTopics(note, settings));
    const excluded = $derived(
        topics.filter(
            (topic) => !included.some((item) => item.id === topic.id),
        ),
    );
    async function moveTopic(topicId: string, include: boolean): Promise<void> {
        const ids = new Set(included.map((topic) => topic.id));
        if (include) ids.add(topicId);
        else ids.delete(topicId);
        onChange(withBroadTopics(settings, [...ids]));
        await tick();
        root.querySelector<HTMLButtonElement>(
            `[data-topic-id="${CSS.escape(topicId)}"]`,
        )?.focus();
    }
</script>

<fieldset
    bind:this={root}
    {disabled}
    class="flex min-h-0 flex-1 flex-col gap-2 disabled:opacity-60"
>
    <legend class="mb-1 text-[13px]/5 font-medium">Topics</legend>
    <div class="grid min-h-0 flex-1 grid-cols-2 gap-2">
        {#each [{ label: "Included", items: included, include: false }, { label: "Excluded", items: excluded, include: true }] as column}
            <section
                aria-label={`${column.label} topics`}
                class="flex min-h-0 flex-col rounded-md border border-border bg-surface"
            >
                <div
                    class="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-b border-border px-2 py-1"
                >
                    <h3 class="text-xs/5 font-medium">
                        {column.label}
                        <span class="text-text-muted"
                            >{column.items.length}</span
                        >
                    </h3>
                    <button
                        type="button"
                        class={[
                            button,
                            "min-h-6! border-transparent! px-1! py-0! text-xs!",
                        ]}
                        disabled={column.include
                            ? !included.length
                            : !excluded.length}
                        onclick={() =>
                            onChange(
                                withBroadTopics(
                                    settings,
                                    column.include
                                        ? []
                                        : topics.map((topic) => topic.id),
                                ),
                            )}
                        >{column.include
                            ? "Exclude all"
                            : "Include all"}</button
                    >
                </div>
                <div
                    data-topic-list
                    class="h-56 min-h-0 flex-1 overflow-y-auto p-1"
                >
                    {#each column.items as topic (topic.id)}
                        {@const childCount = note.topics.filter(
                            (child) =>
                                "broadTopicId" in child &&
                                child.broadTopicId === topic.id,
                        ).length}
                        <button
                            type="button"
                            data-topic-id={topic.id}
                            aria-label={`${column.include ? "Include" : "Exclude"} ${topic.title}`}
                            title={topic.title}
                            onclick={() => moveTopic(topic.id, column.include)}
                            class={[
                                "flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs/5 hover:bg-hover",
                                focusRing,
                            ]}
                        >
                            <span class="min-w-0 flex-1 truncate"
                                >{topic.title}</span
                            >
                            {#if childCount}<span
                                    class="shrink-0 text-text-muted"
                                    title={`${childCount} subtopics included`}
                                    aria-label={`${childCount} subtopics`}
                                    >{childCount}</span
                                >{/if}
                            <span aria-hidden="true" class="text-text-muted"
                                >{column.include ? "←" : "→"}</span
                            >
                        </button>
                    {:else}<p class="p-2 text-xs/5 text-text-muted">
                            {topics.length ? "None" : "No broad topics yet"}
                        </p>{/each}
                </div>
            </section>
        {/each}
    </div>
</fieldset>
