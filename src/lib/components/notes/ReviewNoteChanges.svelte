<script lang="ts">
    import { onMount } from "svelte";
    import { resolveNoteIssue } from "$lib/services/notes";
    import type {
        NoteIssueAction,
        NoteSyncResult,
        SyncedNote,
    } from "$lib/types/notes";
    import { button, input, primaryButton } from "$lib/components/ui/styles";
    let {
        note,
        onResolved,
        onClose,
    }: {
        note: SyncedNote;
        onResolved: (result: NoteSyncResult) => void;
        onClose: () => void;
    } = $props();
    let dialog: HTMLDialogElement;
    let busy = $state(false);
    let errorMessage = $state<string | null>(null);
    let parentId = $state("");
    const issue = $derived(note.syncIssues[0]);
    const parents = $derived(note.topics.filter((topic) => !("text" in topic)));
    $effect(() => {
        issue?.id;
        parentId = "";
        errorMessage = null;
    });
    onMount(() => {
        dialog.showModal();
        return () => dialog.close();
    });
    async function resolve(action: NoteIssueAction): Promise<void> {
        if (busy || !issue) return;
        busy = true;
        errorMessage = null;
        try {
            onResolved(
                await resolveNoteIssue(issue.id, action, parentId || undefined),
            );
        } catch {
            errorMessage = "Unable to save this decision. Please try again.";
        } finally {
            busy = false;
        }
    }
</script>

<dialog
    bind:this={dialog}
    oncancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
    }}
    class="m-auto max-h-[85dvh] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-surface p-6 text-text-primary shadow-xl backdrop:bg-canvas/80"
    aria-labelledby="review-heading"
>
    {#if issue}
        <h2 id="review-heading" class="text-base font-semibold">
            Review note changes
        </h2>
        <p class="mt-3 break-words text-sm font-medium">{issue.title}</p>
        <p class="mt-2 text-sm/5 text-text-secondary">
            {issue.kind === "topicChanged"
                ? "This topic's content changed. Keep its existing questions or remove them from the question bank?"
                : issue.kind === "topicRemoved"
                  ? "This topic is no longer in the note. Keep its questions without this topic link, or remove them from the question bank?"
                  : "This subtopic's broad topic disappeared. Assign its questions to another broad topic or remove the missing parent link."}
        </p>
        <p class="mt-2 text-xs/4 text-text-muted">
            Past answers and results are preserved. Decisions are saved for this
            note.
        </p>
        {#if issue.kind === "orphanedSubtopic"}
            <label
                for="replacement-parent"
                class="mt-4 mb-2 block text-sm font-medium"
                >Replacement broad topic</label
            >
            <select
                id="replacement-parent"
                bind:value={parentId}
                disabled={busy}
                class={input}
                ><option value="">Choose a topic</option
                >{#each parents as parent}<option value={parent.id}
                        >{parent.title}</option
                    >{/each}</select
            >
            <div class="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    class={primaryButton}
                    disabled={busy || !parentId}
                    onclick={() => resolve("assignParent")}>Assign topic</button
                ><button
                    type="button"
                    class={button}
                    disabled={busy}
                    onclick={() => resolve("detachParent")}
                    >Keep without parent</button
                >
            </div>
        {:else}
            <div class="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    class={primaryButton}
                    disabled={busy}
                    onclick={() => resolve("keepQuestions")}
                    >Keep questions</button
                ><button
                    type="button"
                    class={[button, "text-danger"]}
                    disabled={busy}
                    onclick={() => resolve("archiveQuestions")}
                    >Remove questions</button
                >
            </div>
        {/if}
        {#if errorMessage}<p role="alert" class="mt-3 text-sm text-danger">
                {errorMessage}
            </p>{/if}
        <button
            type="button"
            class={[button, "mt-4"]}
            disabled={busy}
            onclick={onClose}>Review later</button
        >
    {/if}
</dialog>
