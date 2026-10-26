<script lang="ts">
    import NoteBlock from "./NoteBlock.svelte";
    import type { SyncedNote } from "$lib/types/notes";
    import { noteTitle } from "$lib/types/workspace";
    let {
        notes,
        selectedNoteId,
        onSelect,
        warnings,
        onMove,
        movingNoteId,
        moveError,
    }: {
        notes: SyncedNote[];
        warnings: { filePath: string; message: string }[];
        selectedNoteId: string | null;
        onSelect: (note: SyncedNote) => void;
        onMove: (noteId: string, isStudying: boolean) => Promise<void>;
        movingNoteId: string | null;
        moveError: string | null;
    } = $props();
    let draggedNoteId = $state<string | null>(null);
    let dropGroup = $state<boolean | null>(null);
    function finishDrag(): void {
        draggedNoteId = null;
        dropGroup = null;
    }
    const availableNotes = $derived(notes.filter((note) => note.isAvailable));
    const unavailableCount = $derived(notes.length - availableNotes.length);
</script>

<aside
    class="flex min-h-0 w-[clamp(140px,26vw,240px)] shrink-0 flex-col border-r border-border bg-sidebar"
    aria-label="Notes"
>
    {#each [{ label: "Studying", id: "studying-heading", studying: true }, { label: "Not studying", id: "other-notes-heading", studying: false }] as group}
        <section
            class={[
                "flex min-h-0 flex-1 flex-col first:border-t-0 border-t border-border",
                dropGroup === group.studying &&
                    "bg-selected ring-1 ring-inset ring-accent",
            ]}
            aria-labelledby={group.id}
            ondragover={(event) => {
                const note = notes.find((item) => item.id === draggedNoteId);
                if (
                    !movingNoteId &&
                    note &&
                    note.isStudying !== group.studying
                ) {
                    event.preventDefault();
                    if (event.dataTransfer)
                        event.dataTransfer.dropEffect = "move";
                    dropGroup = group.studying;
                }
            }}
            ondragleave={(event) => {
                if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                )
                    dropGroup = null;
            }}
            ondrop={(event) => {
                event.preventDefault();
                if (draggedNoteId) void onMove(draggedNoteId, group.studying);
                finishDrag();
            }}
        >
            <h3
                id={group.id}
                class="flex h-[26px] shrink-0 items-center justify-between border-b border-border bg-sidebar px-3 text-xs/4 font-medium text-text-secondary"
            >
                {group.label}<span class="text-text-muted tabular-nums"
                    >{availableNotes.filter(
                        (note) => note.isStudying === group.studying,
                    ).length}</span
                >
            </h3>
            <div
                class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pt-2 pb-4"
            >
                {#each availableNotes.filter((note) => note.isStudying === group.studying) as note (note.id)}
                    <div
                        role="group"
                        aria-label={noteTitle(note)}
                        draggable={!movingNoteId}
                        ondragstart={(event) => {
                            draggedNoteId = note.id;
                            if (event.dataTransfer) {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData(
                                    "text/plain",
                                    note.id,
                                );
                            }
                        }}
                        ondragend={finishDrag}
                        class="flex min-w-0 items-center gap-1"
                    >
                        <div class="min-w-0 flex-1">
                            <NoteBlock
                                {note}
                                selected={selectedNoteId === note.id}
                                {onSelect}
                            />
                        </div>
                    </div>
                {:else}
                    <p class="px-1 pt-2 text-xs/4 text-text-muted">
                        {group.studying
                            ? "No notes in study yet."
                            : "No other STUDY-tagged notes found."}
                    </p>
                {/each}
            </div>
        </section>
    {/each}
    <p role="status" class="sr-only">
        {movingNoteId ? "Saving study status…" : ""}
    </p>
    {#if moveError}<p
            role="alert"
            class="border-t border-border px-3 py-2 text-xs text-danger"
        >
            {moveError}
        </p>{/if}
    {#if warnings.length}
        <details
            class="max-h-40 shrink-0 overflow-y-auto border-t border-border px-3 py-3 text-xs/4 text-warning"
        >
            <summary
                class="cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
                >Sync notices ({warnings.length})</summary
            >
            <ul class="mt-2 space-y-3">
                {#each warnings as warning}<li>
                        <span
                            class="block truncate font-medium"
                            title={warning.filePath}
                            >{warning.filePath.split(/[\\/]/).pop()}</span
                        ><span>{warning.message}</span>
                    </li>{/each}
            </ul>
        </details>
    {/if}
    {#if unavailableCount}<p
            class="border-t border-border px-3 py-3 text-xs/4 text-text-muted"
        >
            {unavailableCount} unavailable {unavailableCount === 1
                ? "note"
                : "notes"}. Saved history retained.
        </p>{/if}
</aside>
