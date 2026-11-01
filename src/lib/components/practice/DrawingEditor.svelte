<script lang="ts">
    import { onMount } from "svelte";
    import type { Root } from "react-dom/client";
    import type {
        ExcalidrawImperativeAPI,
        AppState,
        Zoom,
    } from "@excalidraw/excalidraw/types";
    import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
    import "@excalidraw/excalidraw/index.css";
    import { loadDrawingRuntime } from "$lib/drawing/answers";
    import type { DrawingAnswer } from "$lib/types/exercises";
    import { button } from "$lib/components/ui/styles";

    let {
        drawing,
        disabled = false,
        onChange,
    }: {
        drawing?: DrawingAnswer | null;
        disabled?: boolean;
        onChange: (drawing: DrawingAnswer) => void;
    } = $props();
    let host: HTMLDivElement;
    let api: ExcalidrawImperativeAPI | undefined;
    let root: Root | undefined;
    let loading = $state(true);
    let ready = $state(false);
    let clearDrawing = $state<() => void>();
    let errorMessage = $state<string | null>(null);
    let activeTool = $state("freedraw");
    let renderEditor = $state<() => void>();
    let fittingFrame: number | undefined;
    const width = 1200;
    const height = 800;
    const tools = [
        { type: "selection", label: "Select" },
        { type: "freedraw", label: "Pen" },
        { type: "rectangle", label: "Rectangle" },
        { type: "ellipse", label: "Ellipse" },
        { type: "arrow", label: "Arrow" },
        { type: "line", label: "Line" },
        { type: "text", label: "Text tool" },
        { type: "eraser", label: "Eraser" },
    ] as const;
    function viewport() {
        const zoom = Math.max(
            0.05,
            Math.min(host.clientWidth / width, host.clientHeight / height),
        );
        return {
            zoom: { value: zoom } as Zoom,
            scrollX: (host.clientWidth / zoom - width) / 2,
            scrollY: (host.clientHeight / zoom - height) / 2,
        };
    }
    function fit(): void {
        if (!api || !host.clientWidth || !host.clientHeight) return;
        const target = viewport();
        const state = api.getAppState();
        if (
            Math.abs(state.scrollX - target.scrollX) > 0.01 ||
            Math.abs(state.scrollY - target.scrollY) > 0.01 ||
            Math.abs(state.zoom.value - target.zoom.value) > 0.0001
        )
            api.updateScene({
                appState: {
                    ...target,
                    currentItemFontSize: Math.round(18 / target.zoom.value),
                },
            });
    }
    function scheduleFit(): void {
        if (fittingFrame !== undefined) cancelAnimationFrame(fittingFrame);
        fittingFrame = requestAnimationFrame(() => {
            fittingFrame = undefined;
            fit();
        });
    }
    onMount(() => {
        let disposed = false;
        const initialElements = $state.snapshot(drawing?.elements ?? []);
        let lastSaved = JSON.stringify(initialElements);
        let lastValid: readonly ExcalidrawElement[] = initialElements;
        const scheme = window.matchMedia("(prefers-color-scheme: dark)");
        const observer = new ResizeObserver(scheduleFit);
        const stopWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
        };
        host.addEventListener("wheel", stopWheel, { passive: false });
        observer.observe(host);
        void Promise.all([
            loadDrawingRuntime(),
            import("react"),
            import("react-dom/client"),
        ])
            .then(([runtime, react, reactDom]) => {
                if (disposed) return;
                root = reactDom.createRoot(host);
                clearDrawing = () =>
                    api?.updateScene({
                        elements: [],
                        captureUpdate: runtime.CaptureUpdateAction.IMMEDIATELY,
                    });
                renderEditor = () =>
                    root?.render(
                        react.createElement(runtime.Excalidraw, {
                            initialData: {
                                elements: initialElements,
                                appState: {
                                    ...viewport(),
                                    viewBackgroundColor: "transparent",
                                    currentItemFontFamily: 1,
                                    currentItemFontSize: Math.round(
                                        18 / viewport().zoom.value,
                                    ),
                                    activeTool: {
                                        type: "freedraw",
                                        customType: null,
                                        lastActiveTool: null,
                                        locked: false,
                                    },
                                },
                            },
                            theme: scheme.matches ? "dark" : "light",
                            viewModeEnabled: disabled,
                            autoFocus: !disabled,
                            handleKeyboardGlobally: false,
                            detectScroll: true,
                            validateEmbeddable: false,
                            onPaste: () => false,
                            onLinkOpen: (_element, event) =>
                                event.preventDefault(),
                            UIOptions: {
                                tools: { image: false },
                                canvasActions: {
                                    changeViewBackgroundColor: false,
                                    clearCanvas: false,
                                    loadScene: false,
                                    saveToActiveFile: false,
                                    saveAsImage: false,
                                    toggleTheme: false,
                                    export: false,
                                },
                            },
                            excalidrawAPI: (instance) => {
                                api = instance;
                                loading = false;
                                ready = true;
                                scheduleFit();
                            },
                            onScrollChange: scheduleFit,
                            onChange: (
                                elements: readonly ExcalidrawElement[],
                                appState: AppState,
                            ) => {
                                if (disposed) return;
                                activeTool = appState.activeTool.type;
                                scheduleFit();
                                if (disabled) return;
                                const supported = elements
                                    .filter(
                                        (element) =>
                                            !element.isDeleted &&
                                            [
                                                "rectangle",
                                                "diamond",
                                                "ellipse",
                                                "line",
                                                "arrow",
                                                "freedraw",
                                                "text",
                                            ].includes(element.type),
                                    )
                                    .map((element) => ({
                                        ...element,
                                        link: null,
                                    }));
                                let valid: ExcalidrawElement[] = supported;
                                if (supported.length > 2000)
                                    valid = [...lastValid];
                                else {
                                    valid = supported
                                        .map((element) => {
                                            const [left, top, right, bottom] =
                                                runtime.getCommonBounds([
                                                    element,
                                                ]);
                                            if (
                                                right - left > width ||
                                                bottom - top > height
                                            )
                                                return (
                                                    lastValid.find(
                                                        (saved) =>
                                                            saved.id ===
                                                            element.id,
                                                    ) ?? null
                                                );
                                            const dx =
                                                left < 0
                                                    ? -left
                                                    : right > width
                                                      ? width - right
                                                      : 0;
                                            const dy =
                                                top < 0
                                                    ? -top
                                                    : bottom > height
                                                      ? height - bottom
                                                      : 0;
                                            return dx || dy
                                                ? {
                                                      ...element,
                                                      x: element.x + dx,
                                                      y: element.y + dy,
                                                  }
                                                : element;
                                        })
                                        .filter(
                                            (
                                                element,
                                            ): element is ExcalidrawElement =>
                                                element !== null,
                                        );
                                }
                                if (
                                    JSON.stringify(valid) !==
                                    JSON.stringify(
                                        elements.filter(
                                            (element) => !element.isDeleted,
                                        ),
                                    )
                                )
                                    requestAnimationFrame(() => {
                                        if (!disposed)
                                            api?.updateScene({
                                                elements: valid,
                                            });
                                    });
                                const serialized = JSON.stringify(valid);
                                if (serialized === lastSaved) return;
                                if (serialized.length > 1_800_000) {
                                    errorMessage =
                                        "This drawing is too large. Remove some strokes before continuing.";
                                    api?.updateScene({ elements: lastValid });
                                    return;
                                }
                                errorMessage = null;
                                lastValid = valid;
                                lastSaved = serialized;
                                onChange({
                                    version: 1,
                                    width,
                                    height,
                                    elements: valid,
                                });
                            },
                        }),
                    );
                renderEditor();
            })
            .catch((error) => {
                if (!disposed) {
                    loading = false;
                    errorMessage =
                        error instanceof Error
                            ? error.message
                            : "The drawing editor could not be loaded.";
                }
            });
        const updateTheme = () => renderEditor?.();
        scheme.addEventListener("change", updateTheme);
        return () => {
            disposed = true;
            observer.disconnect();
            scheme.removeEventListener("change", updateTheme);
            host.removeEventListener("wheel", stopWheel);
            if (fittingFrame !== undefined) cancelAnimationFrame(fittingFrame);
            root?.unmount();
        };
    });
    $effect(() => {
        disabled;
        renderEditor?.();
    });
</script>

<div
    data-answer-editor
    data-answer-editor-control
    data-drawing-editor
    class="flex min-h-24 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-control-border bg-surface"
>
    <div
        role="group"
        aria-label="Drawing tools"
        class="flex min-h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 py-1"
    >
        {#each tools as tool}
            <button
                type="button"
                class={[
                    button,
                    "shrink-0 border-transparent bg-transparent px-2",
                    activeTool === tool.type ? "bg-selected! text-accent!" : "",
                ]}
                aria-pressed={activeTool === tool.type}
                disabled={disabled || !ready}
                onclick={() => {
                    api?.setActiveTool({ type: tool.type });
                }}>{tool.label}</button
            >
        {/each}
        <button
            type="button"
            class={[button, "ml-auto shrink-0"]}
            disabled={disabled || !ready}
            onclick={() => clearDrawing?.()}>Clear</button
        >
    </div>
    {#if loading}<p role="status" class="px-3 py-2 text-xs text-text-muted">
            Loading drawing editor…
        </p>{/if}
    {#if errorMessage}<p role="alert" class="px-3 py-2 text-xs text-danger">
            {errorMessage}
        </p>{/if}
    <div
        bind:this={host}
        aria-label="Drawing canvas"
        class="relative min-h-16 min-w-0 flex-1 overflow-hidden bg-surface [&_.excalidraw]:bg-transparent! [&_.layer-ui\_\_wrapper]:hidden! [&_.App-menu]:hidden! [&_.App-menu\_\_left]:hidden! [&_.App-toolbar]:hidden! [&_.App-toolbar-container]:hidden! [&_.App-toolbar--mobile]:hidden! [&_.App-bottom-bar]:hidden! [&_.layer-ui\_\_library]:hidden! [&_.layer-ui\_\_wrapper\_\_top-right]:hidden! [&_.HintViewer]:hidden! [&_.excalidraw\_\_canvas]:bg-transparent!"
    ></div>
</div>
