<script lang="ts">
    import ProviderLogo from "$lib/components/ui/ProviderLogo.svelte";
    import { providerLabel } from "$lib/types/providers";
    import Dropdown from "$lib/components/ui/Dropdown.svelte";
    import {
        focusRing,
        menuItem,
        primaryButton,
        button,
    } from "$lib/components/ui/styles";
    import type { AiConfiguration } from "$lib/types/ai";
    import type { StudyMode } from "$lib/types";

    let {
        quickTweakOpen,
        quickTweakDisabled,
        onQuickTweak,
        studyMode,
        onModeChange,
        aiConfiguration,
        aiLoading,
        aiSelecting,
        aiError,
        onSelectIntegration,
        onManageIntegrations,
        onRetry,
        onStart,
        starting,
        startDisabledReason,
        startError,
    }: {
        quickTweakOpen: boolean;
        quickTweakDisabled: boolean;
        onQuickTweak: () => void;
        studyMode: StudyMode;
        onModeChange: (mode: StudyMode) => void;
        aiConfiguration: AiConfiguration;
        aiLoading: boolean;
        aiSelecting: boolean;
        aiError: string | null;
        onSelectIntegration: (id: string) => Promise<void>;
        onManageIntegrations: () => void;
        onRetry: () => Promise<void>;
        onStart: () => Promise<void>;
        starting: boolean;
        startDisabledReason: string | null;
        startError: string | null;
    } = $props();
    const selectedIntegration = $derived(
        aiConfiguration.integrations.find(
            (item) => item.id === aiConfiguration.activeIntegrationId,
        ),
    );
</script>

<footer
    class="relative shrink-0 border-t border-border bg-sidebar"
    aria-label="Study controls"
>
    <div class="flex min-h-16 items-center gap-3 px-3 py-3">
        <fieldset class="min-w-0 shrink-0">
            <legend class="sr-only">Session mode</legend>
            <div
                class="flex h-10 rounded-md border border-border bg-canvas p-1 text-[13px]/5"
            >
                {#each ["study", "practice"] as mode}
                    <button
                        type="button"
                        aria-pressed={studyMode === mode}
                        onclick={() => onModeChange(mode as StudyMode)}
                        class={[
                            "h-full rounded px-2 hover:bg-hover",
                            focusRing,
                            studyMode === mode
                                ? "bg-selected font-medium text-accent"
                                : "text-text-muted",
                        ]}>{mode === "study" ? "Study" : "Practice"}</button
                    >
                {/each}
            </div>
        </fieldset>
        <div class="w-52 min-w-0 max-w-52 flex-1">
            <Dropdown
                id="ai-quick-select"
                above
                large
                toolbar
                disabled={aiLoading || aiSelecting}
                label={aiLoading
                    ? "Loading AI…"
                    : aiSelecting
                      ? "Switching…"
                      : selectedIntegration
                        ? providerLabel(selectedIntegration.provider)
                        : "Select AI"}
            >
                {#snippet icon()}{#if selectedIntegration}<ProviderLogo
                            provider={selectedIntegration.provider}
                        />{/if}{/snippet}
                {#snippet children(close)}
                    <p class="px-3 py-2 text-xs text-text-muted">
                        AI integration
                    </p>
                    {#each aiConfiguration.integrations as integration}
                        <button
                            type="button"
                            class={[menuItem, "min-h-16 gap-3"]}
                            aria-pressed={aiConfiguration.activeIntegrationId ===
                                integration.id}
                            onclick={async () => {
                                close();
                                await onSelectIntegration(integration.id);
                            }}
                        >
                            <ProviderLogo
                                provider={integration.provider}
                                large
                            />
                            <span class="min-w-0 flex-1"
                                ><span class="block truncate"
                                    >{providerLabel(integration.provider)}</span
                                ><span
                                    class="block truncate text-xs text-text-muted"
                                    >{integration.model ||
                                        "Choose a model"}</span
                                ></span
                            >
                            {#if aiConfiguration.activeIntegrationId === integration.id}<span
                                    class="text-accent"
                                    aria-label="Selected">✓</span
                                >{/if}
                        </button>
                    {:else}<p class="px-3 py-2 text-xs text-text-muted">
                            No integrations added yet.
                        </p>{/each}
                    <div class="mt-1 border-t border-border pt-1">
                        <button
                            type="button"
                            class={menuItem}
                            onclick={() => {
                                close();
                                onManageIntegrations();
                            }}>+ Add or manage integrations</button
                        >
                    </div>
                {/snippet}
            </Dropdown>
        </div>
        <button
            id="quick-tweak-trigger"
            type="button"
            class={[button, "ml-auto h-10 shrink-0 px-2!"]}
            aria-haspopup="dialog"
            aria-expanded={quickTweakOpen}
            disabled={quickTweakDisabled}
            title={quickTweakDisabled
                ? "Select a Studying note first."
                : undefined}
            onclick={onQuickTweak}>Quick tweak</button
        >
        <button
            type="button"
            disabled={starting || !!startDisabledReason}
            title={startDisabledReason ?? "Open a separate session window"}
            onclick={onStart}
            class={[primaryButton, "shrink-0"]}
            >{starting ? "Preparing…" : "Start"}</button
        >
    </div>
    {#if startDisabledReason || starting || startError}<p
            role={startError ? "alert" : "status"}
            class={[
                "border-t border-border px-3 py-2 text-xs/5",
                startError ? "text-danger" : "text-text-muted",
            ]}
        >
            {startError ??
                (starting
                    ? "Preparing your session… Fresh questions may take a moment."
                    : startDisabledReason)}
        </p>{/if}
    {#if aiError}<div
            role="alert"
            class="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-danger"
        >
            <span class="min-w-0 flex-1">{aiError}</span><button
                type="button"
                class={button}
                onclick={onRetry}>Retry</button
            >
        </div>{/if}
</footer>
