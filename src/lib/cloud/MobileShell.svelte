<script lang="ts">
    import { onMount } from "svelte";
    import { isWebBuild } from "$lib/mobile/runtime";
    import PwaPanel from "$lib/web/PwaPanel.svelte";
    import MobileApp from "$lib/mobile/MobileApp.svelte";
    import AccountPanel from "./AccountPanel.svelte";
    import { getCloudSession, serverUrl } from "./client";
    import { httpSyncTransport } from "./transport";
    import type { CloudSession } from "./types";
    let session = $state<CloudSession | null>(null);
    let ready = $state(false);
    let error = $state<string | null>(null);
    onMount(() => {
        void (async () => {
            try {
                session = await getCloudSession();
            } catch (caught) {
                error =
                    typeof caught === "string"
                        ? caught
                        : caught instanceof Error
                          ? caught.message
                          : "Unable to restore your account.";
            } finally {
                ready = true;
            }
        })();
    });
</script>

{#if ready}
    {#key session?.userId ?? "sample"}
        <MobileApp
            accountScope={session ? `${serverUrl()}:${session.userId}` : ""}
            deviceId={session?.deviceId}
            syncTransport={session ? httpSyncTransport : null}
        >
            {#snippet accountPanel()}
                <details open={!session} class="mb-4">
                    <summary
                        class="min-h-11 cursor-pointer text-sm font-medium outline-none"
                        >{session ? session.email : "Sign in to sync"}</summary
                    >
                    <div class="mt-3">
                        <AccountPanel bind:session syncError={error} />
                    </div>
                </details>
                {#if isWebBuild}<PwaPanel />{/if}
            {/snippet}
        </MobileApp>
    {/key}
{:else}<p role="status" class="p-4 text-sm text-text-muted">
        Loading account…
    </p>{/if}

<svelte:head>
    {#if isWebBuild}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/app-icons/icon-256.png" />
        <meta name="theme-color" content="#141414" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
            name="apple-mobile-web-app-status-bar-style"
            content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content="Obstudy" />
    {/if}
</svelte:head>
