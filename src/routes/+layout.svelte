<script lang="ts">
    import { onMount, tick } from "svelte";
    import { isTauri } from "@tauri-apps/api/core";
    import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
    import { currentMonitor, LogicalSize } from "@tauri-apps/api/window";
    import "../app.css";
    import { isIosBuild } from "$lib/mobile/runtime";

    let { children } = $props();

    onMount(() => {
        if (isIosBuild || !isTauri()) return;

        const appWindow = getCurrentWebviewWindow();

        async function showReadyWindow(): Promise<void> {
            await tick();

            try {
                // Size only the initial hidden window, preserving manual resizing on reload.
                if (
                    appWindow.label === "main" &&
                    !(await appWindow.isVisible())
                ) {
                    const monitor = await currentMonitor();
                    if (monitor) {
                        await appWindow.setSize(
                            new LogicalSize(
                                Math.round(
                                    (monitor.size.width * 0.5) /
                                        monitor.scaleFactor,
                                ),
                                Math.round(
                                    (monitor.size.height * 0.9) /
                                        monitor.scaleFactor,
                                ),
                            ),
                        );
                        await appWindow.center();
                    }
                }
            } catch (error) {
                console.error("Unable to set the initial window size.", error);
            }

            try {
                // Tauri accepts hex colors, not the computed rgb() background value.
                const backgroundColor = getComputedStyle(
                    document.documentElement,
                )
                    .getPropertyValue("--color-canvas")
                    .trim();
                await appWindow.setBackgroundColor(backgroundColor);
            } catch (error) {
                console.error(
                    "Unable to synchronize the native window background.",
                    error,
                );
            }

            // Hidden webviews can pause animation frames, so do not wait for one.
            // onMount and tick ensure the DOM is ready without requiring visibility.
            await appWindow.show();
        }

        void showReadyWindow().catch((error) => {
            console.error("Unable to show the application window.", error);
        });
    });
</script>

{@render children()}
