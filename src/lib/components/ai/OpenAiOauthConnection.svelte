<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import {
        connectOpenAiOauth,
        cancelOpenAiOauth,
        getOpenAiOauthAccount,
        listOpenAiOauthModels,
        disconnectOpenAiOauth,
    } from "$lib/services/ai";
    import type { AiModel, OpenAiOauthAccount } from "$lib/types/ai";
    import { button, primaryButton } from "$lib/components/ui/styles";
    import ProviderLogo from "$lib/components/ui/ProviderLogo.svelte";

    let {
        onModels,
        onAccount,
        onConnected,
        connectSavedAccount = false,
    }: {
        onModels: (models: AiModel[]) => void;
        onAccount: (account: OpenAiOauthAccount | null) => void;
        onConnected: (models: AiModel[]) => Promise<void>;
        connectSavedAccount?: boolean;
    } = $props();
    let account = $state<OpenAiOauthAccount | null>(null);
    let busy = $state<"loading" | "login" | "connecting" | "logout" | null>(
        "loading",
    );
    let message = $state<string | null>(null);
    let errorMessage = $state<string | null>(null);
    let mounted = true;
    function report(error: unknown): void {
        errorMessage =
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
                ? error.message
                : "Unable to update the ChatGPT connection. Try again.";
    }
    onMount(() => {
        void getOpenAiOauthAccount()
            .then(async (result) => {
                if (mounted) {
                    account = result;
                    onAccount(result);
                    if (result?.planEnabled && connectSavedAccount)
                        await completeConnection();
                }
            })
            .catch((error) => {
                if (mounted) report(error);
            })
            .finally(() => {
                if (mounted) busy = null;
            });
    });
    async function completeConnection(): Promise<void> {
        busy = "connecting";
        const models = await listOpenAiOauthModels();
        if (!mounted) return;
        onModels(models);
        await onConnected(models);
        if (mounted) message = "ChatGPT is connected and selected for prompts.";
    }
    onDestroy(() => {
        mounted = false;
        if (busy === "login") void cancelOpenAiOauth().catch(() => {});
    });
    async function signIn(): Promise<void> {
        if (busy) return;
        busy = "login";
        message = null;
        errorMessage = null;
        try {
            const result = await connectOpenAiOauth();
            if (!mounted) return;
            account = result;
            onAccount(result);
            if (result.planEnabled) {
                await completeConnection();
            } else {
                message =
                    "Signed in, but ChatGPT plan usage is disabled. Continue with ChatGPT to grant access, or choose an API-key integration.";
            }
        } catch (error) {
            if (mounted) report(error);
        } finally {
            if (mounted) busy = null;
        }
    }
    async function cancel(): Promise<void> {
        try {
            await cancelOpenAiOauth();
        } catch (error) {
            report(error);
        }
    }
    async function signOut(): Promise<void> {
        if (busy) return;
        busy = "logout";
        errorMessage = null;
        message = null;
        try {
            const revoked = await disconnectOpenAiOauth();
            account = null;
            onAccount(null);
            onModels([]);
            message = revoked
                ? "Signed out of ChatGPT. Any saved integration needs sign-in before its next request."
                : "Signed out locally. Remote sign-out was not confirmed; disconnect Obstudy in ChatGPT Settings.";
        } catch (error) {
            report(error);
        } finally {
            busy = null;
        }
    }
</script>

<div
    class="space-y-3 rounded-md border border-border bg-surface p-4"
    aria-label="ChatGPT connection"
    aria-busy={busy !== null}
>
    {#if account}
        <p class="break-all text-sm font-medium">
            {account.email ?? "ChatGPT account connected"}
        </p>
        <p class="text-xs text-text-secondary">
            ChatGPT plan usage is {account.planEnabled
                ? "enabled"
                : "disabled"}.
        </p>
    {:else}
        <p class="text-sm text-text-secondary">
            Connect your ChatGPT plan to use eligible models without an API key.
        </p>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            class={[primaryButton, "inline-flex items-center gap-2"]}
            disabled={busy !== null}
            onclick={signIn}
        >
            <ProviderLogo provider="openaiOauth" />Continue with ChatGPT
        </button>
        {#if busy === "login"}<button
                type="button"
                class={button}
                onclick={cancel}>Cancel sign-in</button
            >
        {:else if account}<button
                type="button"
                class={button}
                disabled={busy !== null}
                onclick={signOut}>Sign out</button
            >{/if}
    </div>
    {#if busy}<p role="status" class="text-xs text-text-muted">
            {busy === "login"
                ? "Finish signing in and granting plan access in your browser…"
                : busy === "connecting"
                  ? "Loading models and connecting your integration…"
                  : busy === "logout"
                    ? "Signing out…"
                    : "Checking saved connection…"}
        </p>{/if}
    {#if message}<p role="status" class="text-xs/5 text-text-secondary">
            {message}
        </p>{/if}
    {#if errorMessage}<p role="alert" class="text-sm text-danger">
            {errorMessage}
        </p>{/if}
</div>
