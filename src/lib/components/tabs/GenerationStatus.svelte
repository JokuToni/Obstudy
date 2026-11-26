<script lang="ts">
    import type { NoteGenerationState } from "$lib/types/questions";
    let { generation }: { generation: NoteGenerationState } = $props();
    const busy = $derived(
        generation.isGenerating || !!generation.maintenanceAction,
    );
    const progress = $derived(generation.progress);
    const percent = $derived(
        progress?.requestedCount
            ? Math.round(
                  (progress.generatedCount / progress.requestedCount) * 100,
              )
            : 0,
    );
</script>

<div
    class="space-y-2 rounded-lg border border-border bg-sidebar p-3"
    aria-busy={busy}
>
    <div class="flex items-center gap-2 text-sm font-medium">
        {#if generation.isGenerating}<span
                aria-hidden="true"
                class="size-2 shrink-0 animate-pulse rounded-full bg-accent-solid motion-reduce:animate-none"
            ></span>{/if}
        <span
            >{generation.isGenerating
                ? "Generating questions"
                : generation.error
                  ? "Generation failed"
                  : progress
                    ? "Generation finished"
                    : "Questions updated"}</span
        >
    </div>
    {#if generation.isGenerating && progress?.phase}
        <p role="status" class="break-words text-xs/5 text-text-secondary">
            {progress.phase === "requesting"
                ? "Waiting for AI response…"
                : progress.phase === "validating"
                  ? "Checking generated questions…"
                  : "Saving questions…"}
            {#if progress.topicTitle}
                · {progress.topicTitle}{/if}
            {#if progress.batchCount}
                · {progress.batchCount} in this batch{/if}
            {#if progress.attempt === 2}
                · Retrying the batch{/if}
        </p>
    {/if}
    {#if generation.isGenerating || progress}
        <div
            class="flex flex-wrap items-center justify-between gap-2 text-xs/5 text-text-secondary"
        >
            <span
                >{busy
                    ? progress
                        ? `Generating ${progress.mode} questions…`
                        : "Preparing question generation…"
                    : "Generation progress"}</span
            >
            {#if progress}<span class="tabular-nums"
                    >{progress.generatedCount} of {progress.requestedCount}
                    saved · {percent}%</span
                >{/if}
        </div>
        <progress
            aria-label="Question generation progress"
            max={progress?.requestedCount || 1}
            value={progress ? progress.generatedCount : undefined}
            class="block h-2 w-full appearance-none overflow-hidden rounded-full border border-border bg-surface accent-accent-solid [&::-moz-progress-bar]:bg-accent-solid [&::-webkit-progress-bar]:bg-surface [&::-webkit-progress-value]:bg-accent-solid"
        ></progress>
    {/if}
    <p role="status" class="text-xs/5 text-text-secondary">
        {generation.isGenerating
            ? "Questions are saved after each batch. You can switch tabs while generation continues."
            : generation.maintenanceAction
              ? generation.maintenanceAction === "remove"
                  ? "Removing questions…"
                  : "Resetting study schedule…"
              : (generation.message ?? "")}
    </p>
    {#if generation.error}<p
            role="alert"
            class="break-words text-sm/5 text-danger"
        >
            {generation.error}
            {progress
                ? "Saved questions are preserved. Try generating again to continue."
                : "Please try again."}
        </p>{/if}
    {#if generation.errorDetails}<details class="text-xs/5 text-text-muted">
            <summary class="cursor-pointer">Technical details</summary>
            <pre
                class="mt-2 whitespace-pre-wrap break-words font-mono">{generation.errorDetails}</pre>
        </details>{/if}
    {#if generation.warnings.length}<details
            open={!!generation.error}
            class="text-xs/5 text-warning"
        >
            <summary class="cursor-pointer"
                >Generation notices ({generation.warnings.length})</summary
            >
            <ul class="mt-2 list-disc space-y-1 pl-4">
                {#each generation.warnings as warning}<li class="break-words">
                        {warning}
                    </li>{/each}
            </ul>
        </details>{/if}
</div>
