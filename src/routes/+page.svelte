<script lang="ts">
    import { onMount } from "svelte";
    import { fetchObsidianNotes } from "$lib/services/notes";
    import type { NoteSyncResult } from "$lib/types/notes";
    import { getNotesFolderPath } from "$lib/services/settings";
    import WelcomeView from "$lib/views/WelcomeView.svelte";
    import HomeView from "$lib/views/HomeView.svelte";
    import PracticeSession from "$lib/components/practice/PracticeSession.svelte";

    let notesFolderPath = $state<string | null>(null);
    let noteSync = $state<NoteSyncResult>({ notes: [], warnings: [] });
    let loadingMessage = $state("Loading settings…");
    let isLoading = $state(true);
    let errorMessage = $state<string | null>(null);
    let practiceExerciseId = $state<string | null>(null);

    async function checkNotesFolderPath(folderPath?: string): Promise<void> {
        isLoading = true;
        errorMessage = null;

        try {
            loadingMessage = "Loading settings…";
            notesFolderPath = folderPath ?? (await getNotesFolderPath());
            if (notesFolderPath) {
                loadingMessage = "Synchronizing notes…";
                noteSync = await fetchObsidianNotes(notesFolderPath);
            }
        } catch {
            errorMessage =
                "Unable to load settings or synchronize notes. Check that the notes folder is available, then try again.";
        } finally {
            isLoading = false;
        }
    }

    onMount(() => {
        practiceExerciseId = new URLSearchParams(window.location.search).get(
            "practice",
        );
        if (practiceExerciseId) {
            isLoading = false;
            return;
        }
        void checkNotesFolderPath();
    });
</script>

<main class="min-h-dvh bg-canvas text-text-primary">
    {#if practiceExerciseId}<PracticeSession exerciseId={practiceExerciseId} />
    {:else if isLoading}
        <p role="status" class="p-8 text-text-secondary">{loadingMessage}</p>
    {:else if errorMessage}
        <p role="alert" class="px-8 pt-8 text-danger">{errorMessage}</p>
        <button
            type="button"
            class="mx-8 mt-4 min-h-9 rounded-md bg-accent-solid px-4 py-2 text-on-accent hover:bg-accent-solid-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onclick={() => checkNotesFolderPath()}
        >
            Try again
        </button>
        <button
            type="button"
            class="mx-8 mt-4 rounded-md border border-border bg-surface px-4 py-2 text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
            onclick={() => {
                errorMessage = null;
                notesFolderPath = null;
            }}>Choose a different folder</button
        >
    {:else if notesFolderPath === null}
        <WelcomeView
            onFolderSaved={(folderPath) => {
                void checkNotesFolderPath(folderPath);
            }}
        />
    {:else}
        <HomeView bind:noteSync />
    {/if}
</main>
