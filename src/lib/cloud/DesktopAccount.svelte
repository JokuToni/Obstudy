<script lang="ts">
    import { onMount } from "svelte";
    import AccountPanel from "$study/cloud/AccountPanel.svelte";
    import {
        button,
        tabSection,
        tabSectionTitle,
    } from "$lib/components/ui/styles";
    import { getNotesFolderPath } from "../services/settings";
    import { getDesktopFolderLink, type DesktopFolderLink } from "./desktop";
    import { serverUrl } from "./client";
    import {
        desktopAccount,
        connectDesktopAccount,
        disconnectDesktopAccount,
        syncDesktopAccount,
        unlinkDesktopAccount,
    } from "./desktopController";

    let folderPath = $state<string | null>(null);
    let link = $state<DesktopFolderLink | null>(null);
    let loading = $state(true);
    let unlinking = $state(false);
    let confirming = $state(false);
    let error = $state<string | null>(null);
    let notice = $state<string | null>(null);
    let accountVersion = $state(0);
    const linkedAccount = $derived(
        link &&
            $desktopAccount.session?.userId === link.userId &&
            serverUrl() === link.serverUrl
            ? $desktopAccount.session.email
            : link?.userId,
    );
    async function refresh() {
        try {
            folderPath = await getNotesFolderPath();
            link = folderPath ? await getDesktopFolderLink(folderPath) : null;
            error = null;
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
        } finally {
            loading = false;
        }
    }
    async function unlink() {
        if (!folderPath || !link || unlinking) return;
        unlinking = true;
        error = null;
        try {
            await unlinkDesktopAccount(folderPath, link);
            link = null;
            confirming = false;
            notice =
                "Folder unlinked. Your notes, questions and saved study data are still on this computer.";
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            await refresh();
            error = caught instanceof Error ? caught.message : String(caught);
        } finally {
            unlinking = false;
            accountVersion++;
        }
    }
    onMount(() => {
        void refresh();
        const changed = () => void refresh();
        window.addEventListener("obstudy-cloud-synced", changed);
        return () =>
            window.removeEventListener("obstudy-cloud-synced", changed);
    });
</script>

{#key accountVersion}
    <AccountPanel
        session={$desktopAccount.session}
        onConnected={connectDesktopAccount}
        onDisconnected={disconnectDesktopAccount}
        onSync={syncDesktopAccount}
        syncing={$desktopAccount.syncing || unlinking}
        lastSync={$desktopAccount.lastSync}
        syncError={$desktopAccount.error}
    />
{/key}
<section class={[tabSection, "mt-4"]} aria-label="Notes folder link">
    <h2 class={tabSectionTitle}>Notes folder link</h2>
    {#if loading}<p role="status" class="mt-3 text-sm text-text-muted">
            Loading folder link…
        </p>
    {:else if link}
        <dl class="mt-3 space-y-2 text-sm">
            <div>
                <dt class="text-xs text-text-muted">Linked account</dt>
                <dd class="break-all text-text-secondary">{linkedAccount}</dd>
            </div>
            <div>
                <dt class="text-xs text-text-muted">Server</dt>
                <dd class="break-all text-text-secondary">{link.serverUrl}</dd>
            </div>
        </dl>
        {#if confirming}
            <div
                role="alertdialog"
                aria-modal="false"
                aria-labelledby="unlink-folder-title"
                class="mt-4 space-y-3 rounded-lg border border-border bg-surface p-4"
            >
                <h3 id="unlink-folder-title" class="text-sm font-semibold">
                    Unlink this folder?
                </h3>
                <p class="text-sm/6 text-text-secondary">
                    This signs you out on this desktop and stops syncing this
                    folder. Your local notes, questions and answers stay here.
                    Your server account and its data stay unchanged.
                </p>
                {#if link.pendingCount > 0}<p class="text-sm/6 text-warning">
                        There are {link.pendingCount} pending sync changes. They will
                        stay locally archived after unlinking.
                    </p>{/if}
                <p class="text-xs/5 text-text-muted">
                    Connecting another account can upload the study data already
                    in this folder.
                </p>
                <div class="flex flex-wrap justify-end gap-2">
                    <button
                        type="button"
                        class={button}
                        disabled={unlinking}
                        onclick={() => (confirming = false)}>Cancel</button
                    >
                    <button
                        type="button"
                        class={[button, "text-danger!"]}
                        disabled={unlinking}
                        onclick={unlink}
                        >{unlinking ? "Unlinking…" : "Unlink folder"}</button
                    >
                </div>
            </div>
        {:else}<button
                type="button"
                class={[button, "mt-4", "text-danger!"]}
                disabled={unlinking || $desktopAccount.syncing}
                onclick={() => {
                    confirming = true;
                    notice = null;
                }}>Unlink folder</button
            >{/if}
    {:else}<p class="mt-3 text-sm/6 text-text-muted">
            This folder is not linked to an account. Sign in to connect it.
        </p>{/if}
    {#if error}<p role="alert" class="mt-3 text-sm/6 text-danger">{error}</p>
        <button
            type="button"
            class={[button, "mt-2"]}
            disabled={unlinking}
            onclick={refresh}>Refresh link</button
        >{/if}
    {#if notice}<p role="status" class="mt-3 text-sm/6 text-success">
            {notice}
        </p>{/if}
</section>
