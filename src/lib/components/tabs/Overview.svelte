<script lang="ts">
    import { onMount } from "svelte";
    import type { SyncedNote } from "$lib/types/notes";
    import { noteTitle } from "$lib/types/workspace";
    import { focusRing } from "$lib/components/ui/styles";
    import { studyQuestionsDueToday } from "$lib/exercises/selection";
    import { studyActivity } from "$lib/analytics/overview";

    let {
        notes,
        onOpenNote,
    }: { notes: SyncedNote[]; onOpenNote: (noteId: string) => void } = $props();
    let now = $state(new Date());
    const activity = $derived(studyActivity(notes, now));
    const reviewNotes = $derived(
        notes
            .filter((note) => note.isStudying)
            .map((note) => ({
                note,
                count: studyQuestionsDueToday(note, now).questions.length,
            }))
            .sort(
                (left, right) =>
                    right.count - left.count ||
                    noteTitle(left.note).localeCompare(noteTitle(right.note)),
            ),
    );
    const totalDueToday = $derived(
        reviewNotes.reduce((sum, item) => sum + item.count, 0),
    );
    onMount(() => {
        const update = () => {
            now = new Date();
        };
        window.addEventListener("focus", update);
        document.addEventListener("visibilitychange", update);
        return () => {
            window.removeEventListener("focus", update);
            document.removeEventListener("visibilitychange", update);
        };
    });
    $effect(() => {
        notes;
        now = new Date();
    });
    $effect(() => {
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        const next = midnight.getTime();
        const timer = setTimeout(
            () => {
                now = new Date();
            },
            Math.max(1, next - Date.now() + 1),
        );
        return () => clearTimeout(timer);
    });
    function dayLabel(date: Date): string {
        return date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    }
</script>

<section class="mx-auto max-w-5xl space-y-6" aria-label="Study overview">
    <dl
        class="grid grid-cols-2 divide-x divide-border border-b border-border py-4"
    >
        {#each [{ label: "Study streak", value: activity.current }, { label: "Longest streak", value: activity.longest }] as statistic}
            <div class="px-4 first:pl-0">
                <dt class="text-[13px]/5 text-text-secondary">
                    {statistic.label}
                </dt>
                <dd class="mt-2 text-[28px]/9 font-semibold tabular-nums">
                    {statistic.value}
                    <span class="text-xs font-normal text-text-muted"
                        >{statistic.value === 1 ? "day" : "days"}</span
                    >
                </dd>
            </div>
        {/each}
    </dl>
    <section aria-labelledby="due-heading">
        <div
            class="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3"
        >
            <h3 id="due-heading" class="text-base/6 font-semibold">
                Today’s reviews
            </h3>
            <span class="text-xs text-text-muted"
                >{totalDueToday} remaining</span
            >
        </div>
        {#if reviewNotes.length}
            <ul class="divide-y divide-border">
                {#each reviewNotes as item (item.note.id)}
                    <li>
                        <button
                            type="button"
                            onclick={() => onOpenNote(item.note.id)}
                            class={[
                                "flex w-full items-center justify-between gap-3 rounded px-1 py-3 text-left hover:bg-hover",
                                focusRing,
                            ]}
                            aria-label={`Open ${noteTitle(item.note)}`}
                        >
                            <span
                                class="min-w-0 flex-1 truncate text-sm"
                                title={noteTitle(item.note)}
                                >{noteTitle(
                                    item.note,
                                )}{#if !item.note.isAvailable || item.note.parseError || item.note.syncIssues.length}<span
                                        class="ml-2 text-xs text-warning"
                                        >{item.note.isAvailable
                                            ? "Needs attention"
                                            : "Note unavailable"}</span
                                    >{/if}</span
                            >
                            <span
                                class="shrink-0 text-[13px]/5 tabular-nums text-text-secondary"
                                >{item.count}
                                {item.count === 1 ? "review" : "reviews"}</span
                            >
                        </button>
                    </li>
                {/each}
            </ul>
            <p class="mt-2 text-xs/5 text-text-muted">
                Remaining FSRS cards due today, including overdue reviews and
                learning cards scheduled later today. All topics included.
            </p>
        {:else}<div class="py-6">
                <p class="text-sm text-text-secondary">No Studying notes yet</p>
                <p class="mt-2 text-xs/4 text-text-muted">
                    Move a note to Studying to see its review count.
                </p>
            </div>{/if}
    </section>
    <section aria-labelledby="activity-heading">
        <div class="flex flex-wrap items-end justify-between gap-2">
            <h3 id="activity-heading" class="text-base/6 font-semibold">
                Study activity
            </h3>
            <span class="text-xs/5 text-text-muted"
                >{activity.todayCount} graded {activity.todayCount === 1
                    ? "answer"
                    : "answers"} today</span
            >
        </div>
        <p class="mt-1 text-xs/5 text-text-muted">
            Graded answers in Study or Practice count toward your streak.
        </p>
        {#if activity.total}
            <ol
                aria-label="Activity over the past 14 days"
                class="mt-4 grid grid-cols-7 gap-2 sm:grid-cols-14"
            >
                {#each activity.recent as day}
                    <li
                        title={`${dayLabel(day.date)}: ${day.count} graded answers`}
                        aria-label={`${dayLabel(day.date)}: ${day.count} graded answers`}
                        class={[
                            "flex min-w-0 flex-col items-center gap-1 rounded-md border px-1 py-2",
                            day.isToday ? "border-accent" : "border-border",
                            day.count ? "bg-selected" : "bg-surface",
                        ]}
                    >
                        <time
                            datetime={`${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, "0")}-${String(day.date.getDate()).padStart(2, "0")}`}
                            class="text-xs/4 text-text-muted"
                            >{day.date.getDate()}</time
                        ><span class="text-sm/5 font-medium tabular-nums"
                            >{day.count}</span
                        >
                    </li>
                {/each}
            </ol>
            <p class="mt-2 text-xs/5 text-text-muted">
                Past 14 days · {activity.recentCount} graded answers
            </p>
        {:else}
            <div
                class="mt-4 rounded-lg border border-border bg-surface px-6 py-6 text-center"
            >
                <p class="text-sm text-text-secondary">No activity yet</p>
                <p class="mt-2 text-xs/4 text-text-muted">
                    Answer and grade a question to start your streak.
                </p>
            </div>
        {/if}
    </section>
</section>
