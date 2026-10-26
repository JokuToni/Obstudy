<script lang="ts">
    import { onMount } from "svelte";
    import { openUrl } from "@tauri-apps/plugin-opener";
    import OpenAiOauthConnection from "$lib/components/ai/OpenAiOauthConnection.svelte";
    import {
        discoverAiModels,
        listOpenAiOauthModels,
        getOpenAiOauthAccount,
        getLastAiResponse,
        listAiModels,
        removeAiIntegration,
        saveAiIntegration,
        selectAiIntegration,
    } from "$lib/services/ai";
    import type {
        AiConfiguration,
        AiIntegration,
        AiModel,
        AiProvider,
        AiResponse,
        AiRateLimits,
        OpenAiOauthAccount,
    } from "$lib/types/ai";
    import {
        button,
        input,
        primaryButton,
        focusRing,
    } from "$lib/components/ui/styles";

    let {
        configuration,
        loading,
        loadError,
        onConfigurationChanged,
    }: {
        configuration: AiConfiguration;
        loading: boolean;
        loadError: string | null;
        onConfigurationChanged: () => Promise<void>;
    } = $props();

    import ProviderLogo from "$lib/components/ui/ProviderLogo.svelte";
    import Dropdown from "$lib/components/ui/Dropdown.svelte";
    import { menuItem } from "$lib/components/ui/styles";
    import { aiProviders, providerLabel } from "$lib/types/providers";

    let oauthAccount = $state<OpenAiOauthAccount | null>(null);
    $effect(() => {
        if (
            configuration.integrations.some(
                (item) => item.provider === "openaiOauth",
            )
        ) {
            void getOpenAiOauthAccount()
                .then((account) => {
                    oauthAccount = account;
                })
                .catch(reportError);
        }
    });
    let editingId = $state<string | null>(null);
    let provider = $state<AiProvider>("openai");
    let model = $state("");
    let reasoningEffort = $state("");
    let maxOutputTokens = $state<number | undefined>(4096);
    let apiKey = $state("");
    let models = $state<AiModel[]>([]);
    const modelOptions = $derived(
        model && editingId && !models.some((item) => item.id === model)
            ? [{ id: model, name: model, effortLevels: [] }, ...models]
            : models,
    );
    const selectedModel = $derived(
        modelOptions.find((item) => item.id === model),
    );
    const effortLevels = $derived(selectedModel?.effortLevels ?? []);
    function applyModels(available: AiModel[]): void {
        models = available;
        if (!models.some((item) => item.id === model)) {
            model = models[0]?.id ?? "";
            reasoningEffort = "";
        } else if (
            reasoningEffort &&
            !models
                .find((item) => item.id === model)
                ?.effortLevels?.includes(reasoningEffort)
        ) {
            reasoningEffort = "";
        }
    }
    function chooseModel(id: string): void {
        model = id;
        reasoningEffort = "";
    }
    let busy = $state<string | null>(null);
    let errorMessage = $state<string | null>(null);
    let statusMessage = $state<string | null>(null);
    let confirmDeleteId = $state<string | null>(null);
    let lastResponse = $state<AiResponse | null>(null);
    let errorLimits = $state<AiRateLimits | null>(null);
    let usageIntegrationId = $state<string | null>(null);
    let formHeading: HTMLHeadingElement;
    let usageVersion = 0;
    const availableProviders = $derived(
        aiProviders.filter(
            (item) =>
                !configuration.integrations.some(
                    (integration) => integration.provider === item.id,
                ),
        ),
    );
    $effect(() => {
        if (
            !editingId &&
            availableProviders.length &&
            !availableProviders.some((item) => item.id === provider)
        ) {
            provider = availableProviders[0].id;
            model = "";
            reasoningEffort = "";
            models = [];
            apiKey = "";
        }
    });
    const rateLimits = $derived(
        errorLimits ?? lastResponse?.rateLimits ?? null,
    );

    function errorText(error: unknown): string {
        if (
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
        )
            return error.message;
        return "The operation failed. Please try again.";
    }
    function reportError(error: unknown): void {
        errorMessage = errorText(error);
        if (error && typeof error === "object" && "rateLimits" in error)
            errorLimits = error.rateLimits as AiRateLimits | null;
    }
    function resetForm(focus = false): void {
        editingId = null;
        provider = "openai";
        model = "";
        reasoningEffort = "";
        apiKey = "";
        maxOutputTokens = 4096;
        models = [];
        errorMessage = null;
        confirmDeleteId = null;
        if (focus) formHeading.focus();
    }
    function editIntegration(integration: AiIntegration): void {
        editingId = integration.id;
        provider = integration.provider;
        model = integration.model;
        reasoningEffort = integration.reasoningEffort ?? "";
        maxOutputTokens = integration.maxOutputTokens;
        apiKey = "";
        models = [];
        errorMessage = null;
        statusMessage = null;
        confirmDeleteId = null;
        formHeading.focus();
        void fetchModels();
    }
    onMount(() => {
        const active = configuration.integrations.find(
            (item) => item.id === configuration.activeIntegrationId,
        );
        if (!loading && active && !active.model) editIntegration(active);
    });
    async function refreshUsage(): Promise<void> {
        const version = ++usageVersion;
        const id = configuration.activeIntegrationId;
        usageIntegrationId = id;
        lastResponse = null;
        errorLimits = null;
        if (!id) return;
        try {
            const response = await getLastAiResponse(id);
            if (
                version === usageVersion &&
                configuration.activeIntegrationId === id
            )
                lastResponse = response;
        } catch (error) {
            if (version === usageVersion) reportError(error);
        }
    }
    // Refresh when selection changes, including selections made from the bottom bar.
    $effect(() => {
        configuration.activeIntegrationId;
        void refreshUsage();
    });

    async function fetchModels(): Promise<void> {
        if (busy) return;
        busy = "models";
        errorMessage = null;
        statusMessage = null;
        try {
            const available =
                provider === "openaiOauth"
                    ? await listOpenAiOauthModels()
                    : apiKey.trim()
                      ? await discoverAiModels(provider, apiKey.trim())
                      : editingId
                        ? await listAiModels(editingId)
                        : [];
            if (provider !== "openaiOauth" && !apiKey.trim() && !editingId)
                throw new Error("Enter your API key before loading models.");
            applyModels(available);
            statusMessage = models.length
                ? `${models.length} models loaded. Choose a model from the dropdown.`
                : "No models were returned for this account.";
        } catch (error) {
            reportError(error);
        } finally {
            busy = null;
        }
    }
    async function saveIntegration(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (busy) return;
        errorMessage = null;
        statusMessage = null;
        if (
            !model.trim() ||
            !maxOutputTokens ||
            !Number.isInteger(maxOutputTokens) ||
            maxOutputTokens < 1
        ) {
            errorMessage =
                "Enter a model ID and positive whole-number output limit.";
            return;
        }
        if (provider !== "openaiOauth" && !editingId && !apiKey.trim()) {
            errorMessage = "Enter an API key for the new integration.";
            return;
        }
        busy = "save";
        try {
            const id = editingId ?? provider;
            await saveAiIntegration(
                {
                    id,
                    provider,
                    model: model.trim(),
                    maxOutputTokens,
                    reasoningEffort: reasoningEffort || null,
                },
                provider === "openaiOauth"
                    ? undefined
                    : apiKey.trim() || undefined,
            );
            editingId = id;
            apiKey = "";
            await onConfigurationChanged();
            statusMessage =
                "Integration saved. Credentials are kept in your system credential store.";
        } catch (error) {
            reportError(error);
        } finally {
            busy = null;
        }
    }
    async function finishOauthConnection(available: AiModel[]): Promise<void> {
        if (!available.length) {
            throw new Error(
                "ChatGPT sign-in succeeded, but no models are available. Reload models before saving the integration.",
            );
        }
        const existing = configuration.integrations.find(
            (item) => item.provider === "openaiOauth",
        );
        const id = existing?.id ?? "openaiOauth";
        const selected =
            available.find((item) => item.id === model) ?? available[0];
        const effort = selected.effortLevels?.includes(reasoningEffort)
            ? reasoningEffort
            : null;
        await saveAiIntegration({
            id,
            provider: "openaiOauth",
            model: selected.id,
            maxOutputTokens: existing?.maxOutputTokens ?? 4096,
            reasoningEffort: effort,
        });
        editingId = id;
        model = selected.id;
        reasoningEffort = effort ?? "";
        await selectAiIntegration(id);
        await onConfigurationChanged();
        statusMessage =
            "ChatGPT integration connected and selected. Model and effort can be changed below.";
    }
    async function activateIntegration(id: string): Promise<void> {
        if (busy) return;
        busy = "select";
        errorMessage = null;
        statusMessage = null;
        try {
            await selectAiIntegration(id);
            await onConfigurationChanged();
            statusMessage = "Active integration updated.";
        } catch (error) {
            reportError(error);
        } finally {
            busy = null;
        }
    }
    async function deleteIntegration(id: string): Promise<void> {
        if (busy) return;
        busy = "delete";
        errorMessage = null;
        statusMessage = null;
        try {
            const revoked = await removeAiIntegration(id);
            if (editingId === id) resetForm();
            confirmDeleteId = null;
            await onConfigurationChanged();
            statusMessage =
                revoked === false
                    ? "Integration removed locally. Remote sign-out could not be confirmed; disconnect Obstudy in ChatGPT Settings."
                    : "Integration and its saved credentials removed.";
        } catch (error) {
            reportError(error);
        } finally {
            busy = null;
        }
    }
</script>

<section class="mx-auto max-w-3xl space-y-8" aria-labelledby="ai-heading">
    <div>
        <h2 id="ai-heading" class="text-[22px]/[30px] font-semibold">
            AI integrations
        </h2>
        <p class="mt-2 text-sm/5 text-text-secondary">
            Connect a provider and choose the model used for your study
            questions.
        </p>
    </div>

    {#if loading}<p role="status" class="text-sm text-text-muted">
            Loading integrations…
        </p>{/if}
    {#if loadError}<div role="alert" class="space-y-2 text-sm text-danger">
            <p>{loadError}</p>
            <button
                type="button"
                class={button}
                onclick={onConfigurationChanged}>Retry</button
            >
        </div>{/if}

    <section class="space-y-3" aria-labelledby="connected-heading">
        <h3 id="connected-heading" class="text-base/6 font-semibold">
            Connected providers
        </h3>
        {#each configuration.integrations as integration (integration.id)}
            <div class="space-y-3 border-b border-border py-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <p
                            class="flex items-center gap-2 break-words text-sm font-medium"
                        >
                            <ProviderLogo provider={integration.provider} />
                            {providerLabel(integration.provider)}
                            {#if configuration.activeIntegrationId === integration.id}<span
                                    class="ml-2 rounded bg-selected px-2 py-1 text-xs text-accent"
                                    >Active</span
                                >{/if}
                        </p>
                        <p class="mt-2 break-all text-xs/4 text-text-muted">
                            {providerLabel(integration.provider)} · {integration.model}
                        </p>
                        {#if integration.provider === "openaiOauth"}
                            <p
                                class="mt-2 break-all text-xs text-text-secondary"
                            >
                                {oauthAccount?.email ?? "ChatGPT account"} · {oauthAccount?.planEnabled
                                    ? "Plan usage enabled"
                                    : "Sign in to enable plan usage"}
                            </p>
                        {/if}
                    </div>
                    <div class="flex flex-wrap gap-2">
                        {#if configuration.activeIntegrationId !== integration.id}<button
                                type="button"
                                class={button}
                                disabled={!!busy || loading}
                                onclick={() =>
                                    activateIntegration(integration.id)}
                                >Use</button
                            >{/if}
                        <button
                            type="button"
                            class={button}
                            disabled={!!busy || loading}
                            onclick={() => editIntegration(integration)}
                            >Edit</button
                        >
                        <button
                            type="button"
                            class={[button, "text-danger"]}
                            disabled={!!busy || loading}
                            onclick={() => {
                                confirmDeleteId = integration.id;
                            }}>Remove</button
                        >
                    </div>
                </div>
                {#if confirmDeleteId === integration.id}
                    <div
                        class="space-y-2 text-sm"
                        role="group"
                        aria-label={`Confirm removal of ${providerLabel(integration.provider)}`}
                    >
                        <p class="text-text-secondary">
                            Remove this integration and its saved credentials?
                        </p>
                        <div class="flex gap-2">
                            <button
                                type="button"
                                class={[button, "text-danger"]}
                                disabled={!!busy}
                                onclick={() =>
                                    deleteIntegration(integration.id)}
                                >Confirm removal</button
                            ><button
                                type="button"
                                class={button}
                                disabled={!!busy}
                                onclick={() => {
                                    confirmDeleteId = null;
                                }}>Cancel</button
                            >
                        </div>
                    </div>
                {/if}
            </div>
        {:else}
            {#if !loading && !loadError}<p
                    class="rounded-lg border border-border bg-surface p-4 text-sm/5 text-text-secondary"
                >
                    No providers connected. Add your first integration below.
                </p>{/if}
        {/each}
    </section>

    <form onsubmit={saveIntegration} class="space-y-4" aria-busy={!!busy}>
        <div class="flex items-center justify-between gap-3">
            <h3
                bind:this={formHeading}
                tabindex="-1"
                class={["text-base/6 font-semibold", focusRing]}
            >
                {editingId ? "Edit integration" : "Add integration"}
            </h3>
            {#if editingId}<button
                    type="button"
                    class={button}
                    disabled={!!busy || !availableProviders.length}
                    onclick={() => resetForm(true)}>Add new</button
                >{/if}
        </div>
        {#if !editingId && !availableProviders.length && !loading}<p
                class="text-sm text-text-secondary"
            >
                All providers are connected. Select Edit above to update a model
                or connection.
            </p>{:else}
            <fieldset
                class="space-y-4"
                disabled={!!busy || loading || !!loadError}
            >
                <legend class="sr-only">Integration details</legend>
                <div class="space-y-2">
                    <p class="text-sm font-medium">Provider</p>
                    <Dropdown
                        id="integration-provider-options"
                        label={providerLabel(provider)}
                        large
                        fullWidth
                        disabled={!!editingId || !!busy || loading}
                    >
                        {#snippet icon()}<ProviderLogo
                                {provider}
                                large
                            />{/snippet}
                        {#snippet children(close)}
                            {#each aiProviders as item}
                                {@const connected =
                                    configuration.integrations.some(
                                        (integration) =>
                                            integration.provider === item.id,
                                    )}
                                <button
                                    type="button"
                                    class={[menuItem, "min-h-16 gap-3"]}
                                    disabled={connected}
                                    onclick={() => {
                                        provider = item.id;
                                        model = "";
                                        reasoningEffort = "";
                                        models = [];
                                        apiKey = "";
                                        close();
                                    }}
                                >
                                    <ProviderLogo provider={item.id} large />
                                    <span class="flex-1">{item.label}</span>
                                    {#if connected}<span
                                            class="text-xs text-text-muted"
                                            >Connected</span
                                        >{/if}
                                </button>
                            {/each}
                        {/snippet}
                    </Dropdown>
                    {#if editingId}<p class="text-xs/4 text-text-muted">
                            One integration per connection type. Edit its model
                            or connection below.
                        </p>{/if}
                </div>
                {#if provider === "openaiOauth"}
                    <OpenAiOauthConnection
                        onAccount={(account) => {
                            oauthAccount = account;
                        }}
                        onModels={applyModels}
                        onConnected={finishOauthConnection}
                        connectSavedAccount={!configuration.integrations.some(
                            (item) => item.provider === "openaiOauth",
                        )}
                    />
                {:else}
                    <div class="space-y-2">
                        <label for="ai-key" class="block text-sm font-medium"
                            >API key {#if editingId}<span
                                    class="font-normal text-text-muted"
                                    >(leave blank to keep saved key)</span
                                >{/if}</label
                        ><input
                            id="ai-key"
                            type="password"
                            class={input}
                            bind:value={apiKey}
                            required={!editingId}
                            autocomplete="new-password"
                            spellcheck="false"
                            placeholder={editingId
                                ? "Saved key is never displayed"
                                : "Enter your provider API key"}
                        />
                        <p class="text-xs/4 text-text-muted">
                            Stored in your system credential store. ChatGPT and
                            Claude subscriptions do not supply API access.
                        </p>
                    </div>
                {/if}
                <div class="space-y-2">
                    <div
                        class="flex flex-wrap items-center justify-between gap-2"
                    >
                        <p id="ai-model-label" class="text-sm font-medium">
                            Model
                        </p>
                        <button
                            type="button"
                            class={button}
                            onclick={fetchModels}
                            disabled={provider !== "openaiOauth" &&
                                !editingId &&
                                !apiKey.trim()}>Load available models</button
                        >
                    </div>
                    <Dropdown
                        id="ai-model-options"
                        labelledBy="ai-model-label"
                        label={selectedModel?.name ?? "No models loaded"}
                        fullWidth
                        disabled={!modelOptions.length}
                    >
                        {#snippet children(close)}
                            {#each modelOptions as availableModel (availableModel.id)}
                                <button
                                    type="button"
                                    class={menuItem}
                                    title={availableModel.id}
                                    aria-pressed={model === availableModel.id}
                                    onclick={() => {
                                        chooseModel(availableModel.id);
                                        close();
                                    }}
                                >
                                    <span class="min-w-0 flex-1 truncate"
                                        >{availableModel.name}</span
                                    >
                                </button>
                            {/each}
                        {/snippet}
                    </Dropdown>
                    <p class="text-xs/4 text-text-muted">
                        Load your account's models, then choose one. Model
                        access depends on your account.
                    </p>
                </div>
                {#if effortLevels.length}
                    <div class="space-y-2">
                        <p id="ai-effort-label" class="text-sm font-medium">
                            Effort
                        </p>
                        <Dropdown
                            id="ai-effort-options"
                            labelledBy="ai-effort-label"
                            label={reasoningEffort || "Model default"}
                            fullWidth
                        >
                            {#snippet children(close)}
                                {#each ["", ...effortLevels] as effort}
                                    <button
                                        type="button"
                                        class={menuItem}
                                        aria-pressed={reasoningEffort ===
                                            effort}
                                        onclick={() => {
                                            reasoningEffort = effort;
                                            close();
                                        }}>{effort || "Model default"}</button
                                    >
                                {/each}
                            {/snippet}
                        </Dropdown>
                        <p class="text-xs/4 text-text-muted">
                            Higher effort can improve complex answers while
                            increasing latency and token use.
                        </p>
                    </div>
                {/if}
                {#if provider !== "openaiOauth"}
                    <div class="space-y-2">
                        <label
                            for="ai-output-limit"
                            class="block text-sm font-medium"
                            >Maximum output tokens</label
                        ><input
                            id="ai-output-limit"
                            type="number"
                            class={input}
                            bind:value={maxOutputTokens}
                            min="1"
                            step="1"
                            required
                        />
                        <p class="text-xs/4 text-text-muted">
                            Limits each answer. The provider may enforce a lower
                            model-specific maximum.
                        </p>
                    </div>
                {:else}<p class="text-xs text-text-muted">
                        ChatGPT plan requests manage their output limit; the API
                        token-limit setting does not apply.
                    </p>{/if}
                <button
                    type="submit"
                    class={primaryButton}
                    disabled={!model ||
                        (provider === "openaiOauth" &&
                            !oauthAccount?.planEnabled)}
                    >Save integration</button
                >
            </fieldset>
        {/if}
        {#if busy}<p role="status" class="text-xs text-text-muted">
                {busy === "models"
                    ? "Loading available models…"
                    : "Updating integration…"}
            </p>{/if}
        {#if errorMessage}<p role="alert" class="text-sm/5 text-danger">
                {errorMessage}
            </p>{/if}
        {#if statusMessage}<p role="status" class="text-sm/5 text-success">
                {statusMessage}
            </p>{/if}
    </form>

    <section
        class="space-y-4 border-t border-border pt-6"
        aria-labelledby="usage-heading"
    >
        <div class="flex items-center justify-between gap-3">
            <h3 id="usage-heading" class="text-base/6 font-semibold">
                Usage and limits
            </h3>
            <button
                type="button"
                class={button}
                disabled={!configuration.activeIntegrationId}
                onclick={refreshUsage}>Refresh</button
            >
        </div>
        <p class="text-xs/4 text-text-muted">
            Latest successful call in this app session. Limits are snapshots
            shared with other account activity, not remaining credit or minutes
            of use.
        </p>
        {#if configuration.integrations.find((item) => item.id === configuration.activeIntegrationId)?.provider === "openaiOauth"}
            <p class="text-sm text-text-secondary">
                Manage ChatGPT plan usage and app access in ChatGPT Settings.
            </p>
            <button
                type="button"
                onclick={() =>
                    openUrl("https://chatgpt.com/#settings").catch(reportError)}
                class={button}>Manage ChatGPT usage</button
            >
        {/if}
        {#if lastResponse}
            <p class="break-all text-xs text-text-secondary">
                {lastResponse.model}
            </p>
            <dl class="grid grid-cols-3 gap-3">
                {#each [{ label: "Input tokens", value: lastResponse.usage.inputTokens }, { label: "Output tokens", value: lastResponse.usage.outputTokens }, { label: "Total tokens", value: lastResponse.usage.totalTokens }] as metric}<div
                    >
                        <dt class="text-xs text-text-muted">{metric.label}</dt>
                        <dd class="mt-1 text-base font-medium tabular-nums">
                            {metric.value.toLocaleString()}
                        </dd>
                    </div>{/each}
            </dl>
        {:else}<p class="text-sm text-text-secondary">
                {usageIntegrationId
                    ? "No usage reported yet for this integration."
                    : "Select an integration to view reported usage."}
            </p>{/if}
        {#if rateLimits && Object.keys(rateLimits.headers).length}
            <p class="text-xs text-text-muted">
                Observed {new Date(
                    rateLimits.observedAt * 1000,
                ).toLocaleString()}
            </p>
            <dl class="space-y-2">
                {#each Object.entries(rateLimits.headers) as [header, value]}<div
                        class="border-b border-border pb-2"
                    >
                        <dt class="break-all text-xs text-text-muted">
                            {header}
                        </dt>
                        <dd class="mt-1 break-all font-mono text-xs">
                            {value}
                        </dd>
                    </div>{/each}
            </dl>
        {:else}<p class="text-xs text-text-muted">
                Remaining requests, tokens, and reset times: unknown until
                reported by the provider.
            </p>{/if}
    </section>
</section>
