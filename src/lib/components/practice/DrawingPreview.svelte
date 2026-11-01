<script lang="ts">
    import { onMount } from "svelte";
    import { loadDrawingRuntime } from "$lib/drawing/answers";
    import type { DrawingAnswer } from "$lib/types/exercises";
    let { drawing }: { drawing: DrawingAnswer } = $props();
    let host: HTMLDivElement;
    let failed = $state(false);
    onMount(() => {
        let disposed = false;
        let renderVersion = 0;
        const scheme = window.matchMedia("(prefers-color-scheme: dark)");
        async function render(): Promise<void> {
            const version = ++renderVersion;
            try {
                const runtime = await loadDrawingRuntime();
                const svg = await runtime.exportToSvg({
                    elements: drawing.elements,
                    files: null,
                    appState: {
                        exportBackground: false,
                        exportWithDarkMode: scheme.matches,
                    },
                    exportPadding: 16,
                    skipInliningFonts: false,
                });
                if (!disposed && version === renderVersion) {
                    failed = false;
                    host.replaceChildren(svg);
                }
            } catch {
                if (!disposed && version === renderVersion) failed = true;
            }
        }
        void render();
        const updateTheme = () => {
            void render();
        };
        scheme.addEventListener("change", updateTheme);
        return () => {
            disposed = true;
            scheme.removeEventListener("change", updateTheme);
        };
    });
</script>

<div
    bind:this={host}
    role="img"
    aria-label="Drawing answer"
    class="max-h-96 overflow-auto rounded-md bg-surface [&_svg]:h-auto [&_svg]:max-w-full"
></div>
{#if failed}<p class="text-xs text-danger">
        The saved drawing could not be displayed.
    </p>{/if}
