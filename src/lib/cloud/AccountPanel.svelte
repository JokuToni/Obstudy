<script lang="ts">
    import { onMount } from "svelte";
    import { getCloudSession, signIn, signOut, serverUrl } from "./client";
    import type { CloudSession } from "./types";
    import {
        button,
        input,
        primaryButton,
        tabSection,
        tabSectionTitle,
    } from "$lib/components/ui/styles";
    let {
        session = $bindable(null),
        onConnected = async () => {},
        onSync,
        onDisconnected = () => {},
        syncing = false,
        lastSync = null,
        syncError = null,
    }: {
        session?: CloudSession | null;
        onConnected?: (session: CloudSession) => Promise<void>;
        onSync?: () => Promise<void>;
        onDisconnected?: () => void;
        syncing?: boolean;
        lastSync?: string | null;
        syncError?: string | null;
    } = $props();
    let email = $state("");
    let password = $state("");
    let register = $state(false);
    let busy = $state(false);
    let error = $state<string | null>(null);
    let restored = $state(false);
    let configured = $state(false);
    onMount(() => {
        void (async () => {
            try {
                configured = !!serverUrl();
                if (!session) {
                    session = await getCloudSession();
                    if (session) await onConnected(session);
                }
            } catch (caught) {
                error =
                    typeof caught === "string"
                        ? caught
                        : caught instanceof Error
                          ? caught.message
                          : "Unable to load your account.";
            } finally {
                restored = true;
            }
        })();
    });
    async function submit() {
        if (busy) return;
        busy = true;
        error = null;
        try {
            session = await signIn(email, password, register);
            password = "";
            await onConnected(session);
        } catch (caught) {
            error =
                typeof caught === "string"
                    ? caught
                    : caught instanceof Error
                      ? caught.message
                      : "Unable to sign in.";
        } finally {
            busy = false;
        }
    }
    async function disconnect() {
        busy = true;
        error = null;
        try {
            await signOut();
            session = null;
            onDisconnected();
        } catch (caught) {
            error =
                typeof caught === "string"
                    ? caught
                    : caught instanceof Error
                      ? caught.message
                      : "Unable to sign out.";
        } finally {
            busy = false;
        }
    }
</script>

<section class={tabSection} aria-label="Account and sync">
    <h2 class={tabSectionTitle}>Account and sync</h2>
    {#if !restored}<p role="status" class="mt-3 text-sm text-text-muted">
            Loading account…
        </p>
    {:else if session}
        <p class="mt-3 break-all text-sm">{session.email}</p>
        <p class="mt-2 text-xs/5 text-text-muted">
            {syncing
                ? "Syncing…"
                : lastSync
                  ? `Last synced ${new Date(lastSync).toLocaleTimeString()}`
                  : "Your saved library is available offline."}
        </p>
        <div class="mt-4 flex flex-wrap gap-2">
            {#if onSync}<button
                    type="button"
                    class={[primaryButton, "min-h-11!"]}
                    disabled={busy || syncing}
                    onclick={onSync}>{syncing ? "Syncing…" : "Sync now"}</button
                >{/if}
            <button
                type="button"
                class={[button, "min-h-11!"]}
                disabled={busy || syncing}
                onclick={disconnect}>Sign out</button
            >
        </div>
    {:else}
        <p class="mt-2 text-sm/6 text-text-secondary">
            Sign in to share questions and progress between your devices. You
            can keep studying offline after signing in.
        </p>
        {#if !configured}<p class="mt-3 text-sm text-warning">
                Set PUBLIC_API_BASE_URL in the project .env and restart the app
                to connect your server.
            </p>{/if}
        <form
            class="mt-4 space-y-3"
            onsubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <label class="block space-y-1 text-sm"
                ><span>Email</span><input
                    class={[input, "min-h-11! text-base!"]}
                    type="email"
                    autocomplete="username"
                    required
                    disabled={busy || !configured}
                    bind:value={email}
                /></label
            >
            <label class="block space-y-1 text-sm"
                ><span>Password</span><input
                    class={[input, "min-h-11! text-base!"]}
                    type="password"
                    autocomplete={register
                        ? "new-password"
                        : "current-password"}
                    minlength="12"
                    maxlength="256"
                    required
                    disabled={busy || !configured}
                    bind:value={password}
                /></label
            >
            <div class="flex flex-wrap gap-2">
                <button
                    class={[primaryButton, "min-h-11!"]}
                    disabled={busy || !configured}
                    type="submit"
                    >{busy
                        ? "Connecting…"
                        : register
                          ? "Create account"
                          : "Sign in"}</button
                ><button
                    type="button"
                    class={[button, "min-h-11!"]}
                    disabled={busy}
                    onclick={() => (register = !register)}
                    >{register
                        ? "Use existing account"
                        : "Create account instead"}</button
                >
            </div>
        </form>
    {/if}
    {#if error || syncError}<p
            role="alert"
            class="mt-3 whitespace-pre-wrap text-sm/6 text-danger"
        >
            {error ?? syncError}
        </p>{/if}
</section>
