<script lang="ts">
    import type { SyncedNote } from "$lib/types/notes";
    import { topicProgress } from "$lib/analytics/topics";
    import { focusRing, tabSectionTitle } from "$lib/components/ui/styles";

    let { note }: { note: SyncedNote } = $props();
    const topics = $derived(topicProgress(note));
    let expandedTopics = $state<string[]>([]);

    function toggleTopic(topicId: string): void {
        expandedTopics = expandedTopics.includes(topicId)
            ? expandedTopics.filter((id) => id !== topicId)
            : [...expandedTopics, topicId];
    }
</script>

<section aria-label="Topic progress" class="w-full max-w-xl">
    <div class="flex min-h-8 items-center justify-between gap-3">
        <h3 class={tabSectionTitle}>Topics and review schedule</h3>
        <span class="text-right text-xs/5 text-text-muted"
            >{topics.length} {topics.length === 1 ? "topic" : "topics"}</span
        >
    </div>
    <p class="mt-3 text-xs/5 text-text-muted">
        Grades use the latest 50 graded answers per topic, or all available
        answers.
    </p>
    {#if topics.length}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus this region to scroll the table horizontally.) -->
        <div
            role="region"
            aria-label="Topic review table"
            tabindex="0"
            class="mt-3 overflow-x-auto rounded-lg border border-border bg-sidebar outline-none"
        >
            <table
                class="w-full min-w-[520px] table-fixed border-collapse text-[13px]/5"
                aria-label="Topics and review schedule"
            >
                <colgroup>
                    <col class="w-[28%]" />
                    <col class="w-[16%]" />
                    <col class="w-[10%]" />
                    <col class="w-[24%]" />
                    <col class="w-[22%]" />
                </colgroup>
                <thead class="bg-surface text-[11px]/5 text-text-muted">
                    <tr>
                        <th scope="col" class="px-2 py-2 text-left font-medium"
                            >Topic</th
                        >
                        <th scope="col" class="px-2 py-2 text-right font-medium"
                            >Due today</th
                        >
                        <th scope="col" class="px-2 py-2 text-right font-medium"
                            >Cards</th
                        >
                        <th scope="col" class="px-2 py-2 text-left font-medium"
                            >Next review</th
                        >
                        <th scope="col" class="px-2 py-2 text-right font-medium"
                            >Grade</th
                        >
                    </tr>
                </thead>
                <tbody>
                    {#each topics as topic (topic.id)}
                        {@const expanded = expandedTopics.includes(topic.id)}
                        {@const scheduleId = `topic-schedule-${note.id}-${topic.id}`}
                        <tr
                            class="border-t border-border align-top hover:bg-hover"
                        >
                            <th scope="row" class="p-0 text-left font-medium">
                                <button
                                    type="button"
                                    aria-label={`${topic.title} review schedule`}
                                    aria-expanded={expanded}
                                    aria-controls={scheduleId}
                                    onclick={() => toggleTopic(topic.id)}
                                    class={[
                                        "flex min-h-12 w-full items-start gap-1.5 px-2 py-3 text-left hover:bg-hover",
                                        focusRing,
                                    ]}
                                >
                                    <svg
                                        class={[
                                            "mt-1 size-3 shrink-0 text-text-muted",
                                            expanded ? "rotate-90" : "",
                                        ]}
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                        aria-hidden="true"
                                        ><path d="m9 6 6 6-6 6" /></svg
                                    >
                                    <span class="min-w-0 break-words"
                                        >{topic.title}</span
                                    >
                                </button>
                            </th>
                            <td class="px-2 py-3 text-right tabular-nums"
                                >{topic.dueToday}</td
                            >
                            <td
                                class="px-2 py-3 text-right tabular-nums text-text-secondary"
                                >{topic.total}</td
                            >
                            <td class="px-2 py-3 text-xs/5 text-text-secondary">
                                {#if topic.next}
                                    <time datetime={topic.next.toISOString()}>
                                        <span class="block"
                                            >{topic.next.toLocaleDateString(
                                                undefined,
                                                {
                                                    month: "short",
                                                    day: "numeric",
                                                    year: "numeric",
                                                },
                                            )}</span
                                        >
                                        <span
                                            class="block text-[11px]/4 text-text-muted"
                                            >{topic.next.toLocaleTimeString(
                                                undefined,
                                                {
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                },
                                            )}</span
                                        >
                                    </time>
                                {:else}<span aria-label="No scheduled review"
                                        >—</span
                                    >{/if}
                            </td>
                            <td class="px-2 py-3 text-right">
                                <span
                                    class="block font-semibold tabular-nums"
                                    aria-label={`${topic.title} grade ${topic.grade}`}
                                    >{topic.grade}</span
                                >
                                <span
                                    class="block text-[11px]/4 text-text-muted"
                                    >{topic.average === null
                                        ? "No grades yet"
                                        : `${Math.round(topic.average * 100)}% · ${topic.count}/50 answers`}</span
                                >
                            </td>
                        </tr>
                        <tr id={scheduleId} hidden={!expanded}>
                            <td
                                colspan="5"
                                class="border-t border-border bg-surface/40 px-3 py-3"
                            >
                                {#if topic.days.length}
                                    <table
                                        class="w-full text-xs/5 text-text-secondary"
                                        aria-label={`${topic.title} reviews by date`}
                                    >
                                        <thead
                                            ><tr
                                                class="border-b border-border text-text-muted"
                                                ><th
                                                    scope="col"
                                                    class="pb-2 text-left font-medium"
                                                    >Review date</th
                                                ><th
                                                    scope="col"
                                                    class="pb-2 text-right font-medium"
                                                    >Cards</th
                                                ></tr
                                            ></thead
                                        >
                                        <tbody>
                                            {#each topic.days as day}
                                                <tr
                                                    class="border-b border-border last:border-0"
                                                >
                                                    <th
                                                        scope="row"
                                                        class="py-1.5 text-left font-normal"
                                                        ><time
                                                            datetime={day.date.toISOString()}
                                                            >{day.date.toLocaleDateString(
                                                                undefined,
                                                                {
                                                                    weekday:
                                                                        "short",
                                                                    month: "short",
                                                                    day: "numeric",
                                                                    year: "numeric",
                                                                },
                                                            )}</time
                                                        ></th
                                                    >
                                                    <td
                                                        class="py-1.5 text-right tabular-nums"
                                                        >{day.count}</td
                                                    >
                                                </tr>
                                            {/each}
                                        </tbody>
                                    </table>
                                {:else}<p class="text-xs/5 text-text-muted">
                                        No scheduled cards.
                                    </p>{/if}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {:else}<p class="py-6 text-sm text-text-muted">No broad topics yet.</p>{/if}
</section>
