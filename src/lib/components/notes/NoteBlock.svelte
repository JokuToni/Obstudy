<script lang="ts">
    import { noteTitle } from "$lib/types/workspace";
    import type { SyncedNote } from "$lib/types/notes";
    import { focusRing } from "$lib/components/ui/styles";
    let {
        note,
        selected = false,
        onSelect,
    }: {
        note: SyncedNote;
        selected?: boolean;
        onSelect: (note: SyncedNote) => void;
    } = $props();
    const title = $derived(noteTitle(note));
</script>

<button
    type="button"
    title={note.file.path}
    aria-pressed={selected}
    onclick={() => onSelect(note)}
    class={[
        "flex min-h-8 w-full items-center gap-2 rounded border-l-2 px-2 py-2 text-left text-[13px]/5 hover:bg-hover",
        focusRing,
        selected
            ? "border-accent bg-selected font-medium text-text-primary"
            : "border-transparent text-text-secondary",
    ]}
>
    <svg
        class="size-4 shrink-0 text-text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
        ><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" /></svg
    >
    <span class="min-w-0 flex-1 truncate">{title}</span>
    {#if note.parseError || note.syncIssues.length}<span
            class="text-xs text-warning"
            aria-label={note.parseError
                ? "Topic parsing error"
                : "Changes need review"}>!</span
        >{/if}
</button>
