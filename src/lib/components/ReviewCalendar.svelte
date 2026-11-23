<script lang="ts">
    import type { SyncedNote } from "$lib/types/notes";
    import { reviewCalendar } from "$lib/analytics/reviewCalendar";
    import { button } from "$lib/components/ui/styles";

    const calendarButton = `${button} inline-flex h-8 items-center justify-center px-2! py-0! text-xs!`;

    let { notes, now }: { notes: SyncedNote[]; now: Date } = $props();
    let selectedMonth = $state<Date | null>(null);
    const month = $derived(
        selectedMonth ?? new Date(now.getFullYear(), now.getMonth(), 1),
    );
    const monthLabel = $derived(
        month.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    );
    const calendar = $derived(reviewCalendar(notes, month, now));
    const weekdays = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ];

    function moveMonth(direction: number): void {
        selectedMonth = new Date(
            month.getFullYear(),
            month.getMonth() + direction,
            1,
        );
    }
    function dateKey(date: Date): string {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
    function dayLabel(date: Date, count: number): string {
        return `${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}: ${count} ${count === 1 ? "review" : "reviews"}`;
    }
</script>

<section
    aria-labelledby="review-calendar-heading"
    class="w-full max-w-xl rounded-lg border border-border bg-sidebar p-3 sm:p-4"
>
    <div
        class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border pb-3"
    >
        <h3
            id="review-calendar-heading"
            class="m-0 flex min-h-8 items-center text-sm/5 font-semibold"
        >
            Review calendar
        </h3>
        <div
            role="group"
            class="flex h-8 items-center gap-1"
            aria-label="Calendar navigation"
        >
            <button
                type="button"
                class={calendarButton}
                aria-label="Previous month"
                onclick={() => moveMonth(-1)}>‹</button
            >
            <button
                type="button"
                class={calendarButton}
                onclick={() => (selectedMonth = null)}>Today</button
            >
            <button
                type="button"
                class={calendarButton}
                aria-label="Next month"
                onclick={() => moveMonth(1)}>›</button
            >
        </div>
    </div>
    <p class="mt-3 text-xs/5 font-medium" aria-live="polite">{monthLabel}</p>
    <table
        class="mt-2 w-full table-fixed border-separate border-spacing-0"
        aria-label={`Scheduled reviews for ${monthLabel}`}
    >
        <thead>
            <tr>
                {#each weekdays as weekday}
                    <th
                        scope="col"
                        class="pb-2 text-center text-[11px]/4 font-normal text-text-muted"
                        ><abbr title={weekday} class="no-underline"
                            >{weekday.slice(0, 3)}</abbr
                        ></th
                    >
                {/each}
            </tr>
        </thead>
        <tbody
            class="[&>tr:first-child>td]:border-t [&>tr:first-child>td:first-child]:rounded-tl-lg [&>tr:first-child>td:last-child]:rounded-tr-lg [&>tr:last-child>td:first-child]:rounded-bl-lg [&>tr:last-child>td:last-child]:rounded-br-lg"
        >
            {#each calendar.weeks as week}
                <tr>
                    {#each week as day}
                        <td
                            aria-label={day
                                ? dayLabel(day.date, day.count)
                                : undefined}
                            aria-current={day?.isToday ? "date" : undefined}
                            class={[
                                "overflow-hidden border-r border-b border-border p-0 align-top first:border-l",
                                day?.isToday
                                    ? "bg-selected"
                                    : day
                                      ? "bg-surface/40"
                                      : "",
                            ]}
                        >
                            {#if day}
                                <div
                                    class={[
                                        "flex min-h-12 min-w-0 flex-col justify-between gap-1 p-1.5",
                                        day.isToday
                                            ? "ring-1 ring-inset ring-accent"
                                            : "",
                                    ]}
                                >
                                    <time
                                        datetime={dateKey(day.date)}
                                        class="text-[11px]/4 text-text-muted"
                                        >{day.date.getDate()}<span
                                            class="sr-only"
                                            >{day.isToday
                                                ? ", today"
                                                : ""}</span
                                        ></time
                                    >
                                    <span
                                        class={[
                                            "truncate text-right text-[13px]/4 tabular-nums",
                                            day.count
                                                ? "font-medium text-text-primary"
                                                : "text-text-muted",
                                        ]}>{day.count}</span
                                    >
                                </div>
                            {/if}
                        </td>
                    {/each}
                </tr>
            {/each}
        </tbody>
    </table>
    <p class="mt-2 text-xs/5 text-text-secondary">
        {calendar.total} scheduled {calendar.total === 1 ? "review" : "reviews"} this
        month
    </p>
    <p class="mt-1 text-xs/5 text-text-muted">
        Current schedules for Studying notes. Overdue reviews are included
        today. Dates update after you study.
    </p>
</section>
