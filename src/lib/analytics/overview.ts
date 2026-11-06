import type { SyncedNote } from "$lib/types/notes";

const dayMilliseconds = 86400000;

/** Calendar-day identities avoid treating DST's 23/25-hour days as streak gaps. */
export function localDay(date: Date): number {
    return (
        Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
        dayMilliseconds
    );
}

function dateForDay(day: number): Date {
    const utc = new Date(day * dayMilliseconds);
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

export function studyActivity(notes: SyncedNote[], now = new Date()) {
    const today = localDay(now);
    const counts = new Map<number, number>();
    const seen = new Set<string>();
    for (const note of notes)
        for (const answer of note.answers) {
            if (
                seen.has(answer.id) ||
                answer.points === null ||
                !Number.isFinite(answer.points)
            )
                continue;
            const date = new Date(answer.answeredAt);
            if (!Number.isFinite(date.getTime()) || date > now) continue;
            seen.add(answer.id);
            const day = localDay(date);
            counts.set(day, (counts.get(day) ?? 0) + 1);
        }
    const days = [...counts.keys()].sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    for (let index = 0; index < days.length; index++) {
        run = index > 0 && days[index] === days[index - 1] + 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    let current = 0;
    const latest = days.at(-1);
    if (latest !== undefined && today - latest <= 1) {
        for (let day = latest; counts.has(day); day--) current++;
    }
    const recent = Array.from({ length: 14 }, (_, index) => {
        const day = today - 13 + index;
        return {
            day,
            date: dateForDay(day),
            count: counts.get(day) ?? 0,
            isToday: day === today,
        };
    });
    return {
        current,
        longest,
        todayCount: counts.get(today) ?? 0,
        recent,
        recentCount: recent.reduce((sum, day) => sum + day.count, 0),
        total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    };
}
