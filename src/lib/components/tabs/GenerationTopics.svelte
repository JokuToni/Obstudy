<script lang="ts">
    import type { SyncedNote } from "$lib/types/notes";
    let {
        note,
        selectedTopicId,
        disabled,
        onSelect,
    }: {
        note: SyncedNote;
        selectedTopicId: string | null;
        disabled: boolean;
        onSelect: (id: string | null) => void;
    } = $props();
    let expanded = $state<string[]>([]);
    const broadTopics = $derived(
        note.topics.filter((topic) => !("text" in topic)),
    );
    const subtopics = $derived(note.topics.filter((topic) => "text" in topic));
    function count(id: string): number {
        const ids = new Set([
            id,
            ...subtopics
                .filter((topic) => topic.broadTopicId === id)
                .map((topic) => topic.id),
        ]);
        return note.questions.filter((question) =>
            question.topicIds.some((id) => ids.has(id)),
        ).length;
    }
</script>

<fieldset {disabled} class="min-w-0 space-y-2 disabled:opacity-60">
    <legend class="mb-2 text-sm font-medium">Generate by topic</legend>
    <label class="flex min-h-9 cursor-pointer items-center gap-2 text-xs">
        <input
            type="radio"
            name={`generation-topic-${note.id}`}
            checked={selectedTopicId === null}
            onchange={() => onSelect(null)}
            class="accent-accent-solid"
        />
        Whole note
        <span class="text-text-muted">· complete the basic set first</span>
    </label>
    <div
        class="max-h-64 min-w-0 overflow-y-auto rounded-lg border border-border bg-sidebar"
    >
        {#each broadTopics as topic (topic.id)}
            {@const children = subtopics.filter(
                (child) => child.broadTopicId === topic.id,
            )}
            <div class="border-b border-border last:border-b-0">
                <div class="flex min-w-0 items-center gap-2 px-2 py-1">
                    <button
                        type="button"
                        aria-label={`Expand ${topic.title}`}
                        aria-expanded={expanded.includes(topic.id)}
                        aria-controls={`generation-children-${topic.id}`}
                        disabled={disabled || !children.length}
                        class="flex size-8 shrink-0 items-center justify-center rounded text-text-muted hover:bg-hover disabled:opacity-40"
                        onclick={() =>
                            (expanded = expanded.includes(topic.id)
                                ? expanded.filter((id) => id !== topic.id)
                                : [...expanded, topic.id])}
                    >
                        <span aria-hidden="true"
                            >{expanded.includes(topic.id) ? "▾" : "▸"}</span
                        >
                    </button>
                    <label
                        class="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 text-xs"
                    >
                        <input
                            type="radio"
                            name={`generation-topic-${note.id}`}
                            aria-label={`Generate for ${topic.title}`}
                            checked={selectedTopicId === topic.id}
                            onchange={() => onSelect(topic.id)}
                            disabled={!children.length}
                            class="shrink-0 accent-accent-solid"
                        />
                        <span class="min-w-0 flex-1 break-words"
                            >{topic.title}</span
                        >
                        <span class="shrink-0 text-text-muted"
                            >{count(topic.id)} questions</span
                        >
                    </label>
                </div>
                <div
                    id={`generation-children-${topic.id}`}
                    hidden={!expanded.includes(topic.id)}
                    class="border-t border-border bg-surface py-1 pl-10 pr-2"
                >
                    {#each children as child (child.id)}
                        <label
                            class="flex min-h-9 min-w-0 cursor-pointer items-center gap-2 px-2 text-xs"
                        >
                            <input
                                type="radio"
                                name={`generation-topic-${note.id}`}
                                aria-label={`Generate for ${child.title}`}
                                checked={selectedTopicId === child.id}
                                onchange={() => onSelect(child.id)}
                                class="shrink-0 accent-accent-solid"
                            />
                            <span class="min-w-0 flex-1 break-words"
                                >{child.title}</span
                            ><span class="shrink-0 text-text-muted"
                                >{count(child.id)} questions</span
                            >
                        </label>
                    {/each}
                </div>
            </div>
        {/each}
        {#each subtopics.filter((topic) => !topic.broadTopicId) as topic (topic.id)}
            <label
                class="flex min-h-9 cursor-pointer items-center gap-2 border-t border-border px-4 text-xs"
            >
                <input
                    type="radio"
                    name={`generation-topic-${note.id}`}
                    aria-label={`Generate for ${topic.title}`}
                    checked={selectedTopicId === topic.id}
                    onchange={() => onSelect(topic.id)}
                    class="accent-accent-solid"
                />
                <span class="min-w-0 flex-1 break-words">{topic.title}</span
                ><span class="text-text-muted">{count(topic.id)} questions</span
                >
            </label>
        {/each}
    </div>
    <p class="text-xs/5 text-text-muted">
        Choose a broad topic to include all its subtopics, or expand it to
        choose one. Then set the count, difficulty and format and select
        Generate questions.
    </p>
</fieldset>
