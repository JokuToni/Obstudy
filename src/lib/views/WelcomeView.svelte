<script lang="ts">
    import { open } from "@tauri-apps/plugin-dialog";
    import { setNotesFolderPath } from "$lib/services/settings";
    import { initializeDatabase } from "$lib/services/database";

    let { onFolderSaved }: { onFolderSaved: (folderPath: string) => void } =
        $props();

    let folderPath = $state("");
    let isPicking = $state(false);
    let isSaving = $state(false);
    let errorMessage = $state<string | null>(null);
    const isBusy = $derived(isPicking || isSaving);

    async function chooseFolder(): Promise<void> {
        if (isBusy) return;
        isPicking = true;
        errorMessage = null;

        try {
            const selectedPath = await open({
                directory: true,
                multiple: false,
                title: "Select your Obsidian vault",
            });

            if (selectedPath !== null) {
                folderPath = selectedPath;
            }
        } catch {
            errorMessage =
                "Unable to open the folder picker. Enter the full folder path instead.";
        } finally {
            isPicking = false;
        }
    }

    async function saveFolder(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (isBusy) return;

        errorMessage = null;
        if (folderPath.trim().length === 0) {
            errorMessage =
                "Enter a folder path or choose a folder to continue.";
            return;
        }

        isSaving = true;
        let failureMessage =
            "Unable to initialize the database. Check that the path points to an existing folder you can write to, then try again.";
        try {
            await initializeDatabase(folderPath);
            failureMessage =
                "The database is ready, but your folder path could not be saved. Please try again.";
            await setNotesFolderPath(folderPath);
        } catch {
            errorMessage = failureMessage;
            return;
        } finally {
            isSaving = false;
        }

        onFolderSaved(folderPath);
    }
</script>

<section
    class="flex min-h-dvh items-center justify-center px-8 py-12"
    aria-labelledby="welcome-heading"
>
    <div class="w-full max-w-[27.5rem]">
        <h1 id="welcome-heading" class="text-[26px]/[34px] font-semibold">
            Welcome to Obstudy
        </h1>
        <p class="mt-3 text-sm/5 text-text-secondary">
            Connect your Obsidian vault to start studying from your notes. Enter
            its folder path or choose it on your computer.
        </p>

        <form class="mt-8 space-y-4" onsubmit={saveFolder} aria-busy={isBusy}>
            <div class="space-y-2">
                <label for="notes-folder" class="block text-sm/5 font-medium"
                    >Notes folder</label
                >
                <input
                    id="notes-folder"
                    type="text"
                    bind:value={folderPath}
                    disabled={isBusy}
                    aria-invalid={errorMessage ? true : undefined}
                    aria-describedby={errorMessage
                        ? "folder-help folder-error"
                        : "folder-help"}
                    placeholder="/Users/yourname/Documents/MyVault"
                    autocomplete="off"
                    spellcheck="false"
                    class="min-h-9 w-full rounded-md border border-control-border bg-surface px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60"
                />
                <p id="folder-help" class="text-xs/4 text-text-muted">
                    Use the full folder path. Your selection is saved on this
                    computer.
                </p>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-3">
                <button
                    type="button"
                    onclick={chooseFolder}
                    disabled={isBusy}
                    class="min-h-9 rounded-md border border-control-border bg-surface px-3 py-2 text-[13px]/5 transition-colors hover:bg-hover active:bg-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none disabled:cursor-wait disabled:opacity-60"
                >
                    {isPicking ? "Choosing folder…" : "Choose folder…"}
                </button>
                <button
                    type="submit"
                    disabled={isBusy}
                    class="min-h-9 rounded-md bg-accent-solid px-4 py-2 text-[13px]/5 font-medium text-on-accent transition-colors hover:bg-accent-solid-hover active:bg-accent-solid-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none disabled:cursor-wait disabled:opacity-60"
                >
                    {isSaving ? "Setting up…" : "Save and continue"}
                </button>
            </div>

            {#if errorMessage}
                <p id="folder-error" role="alert" class="text-sm/5 text-danger">
                    {errorMessage}
                </p>
            {/if}
        </form>
    </div>
</section>
