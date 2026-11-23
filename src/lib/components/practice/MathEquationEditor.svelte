<script lang="ts">
    import { onMount } from "svelte";
    import "mathquill/build/mathquill.css";
    import {
        loadMathQuill,
        type MathField,
        type EquationCommand,
    } from "$lib/math/mathquill";
    import { button, primaryButton } from "$lib/components/ui/styles";

    let {
        initialLatex = "",
        initialCommand,
        onInsert,
        onCancel,
    }: {
        initialLatex?: string;
        initialCommand?: EquationCommand;
        onInsert: (latex: string) => string | null;
        onCancel: () => void;
    } = $props();
    let host: HTMLSpanElement;
    let field: MathField | undefined;
    let loading = $state(true);
    let latex = $state("");
    let errorMessage = $state<string | null>(null);
    const pendingCommands: EquationCommand[] = [];

    export function focus(): void {
        field?.focus();
    }
    export function insertCommand(command: EquationCommand): void {
        if (!field) {
            pendingCommands.push(command);
            return;
        }
        field.cmd(command.latex);
        field.focus();
    }
    function insert(): void {
        if (!field || !latex.trim()) return;
        errorMessage = onInsert(field.latex());
    }
    onMount(() => {
        let disposed = false;
        void loadMathQuill()
            .then((mathQuill) => {
                if (disposed) return;
                field = mathQuill.MathField(host, {
                    spaceBehavesLikeTab: true,
                    restrictMismatchedBrackets: true,
                    autoCommands: "pi theta sqrt sum",
                    substituteTextarea: () => {
                        const input = document.createElement("textarea");
                        input.setAttribute("aria-label", "Equation");
                        input.setAttribute("autocapitalize", "off");
                        input.setAttribute("autocomplete", "off");
                        input.spellcheck = false;
                        return input;
                    },
                    handlers: {
                        edit: (edited) => {
                            latex = edited.latex();
                            errorMessage = null;
                        },
                        enter: insert,
                    },
                });
                // MathQuill emits mathbb notation but reads its number-set aliases.
                field.latex(
                    initialLatex.replace(/\\mathbb\{([NPZQRCH])\}/g, "\\$1"),
                );
                if (initialLatex) field.select();
                if (initialCommand) insertCommand(initialCommand);
                for (const command of pendingCommands) insertCommand(command);
                field.focus();
            })
            .catch((error) => {
                if (!disposed)
                    errorMessage =
                        error instanceof Error
                            ? error.message
                            : "The equation editor could not be loaded.";
            })
            .finally(() => {
                if (!disposed) loading = false;
            });
        return () => {
            disposed = true;
            field?.revert();
        };
    });
</script>

<svelte:window
    onkeydown={(event) => {
        if (
            event.key === "Escape" &&
            event.target instanceof Node &&
            host
                ?.closest("[data-answer-editor-control]")
                ?.contains(event.target)
        ) {
            event.preventDefault();
            onCancel();
        }
    }}
/>

<section
    data-answer-editor-control
    aria-label="Equation editor"
    class="space-y-3 border-b border-border bg-sidebar p-3"
>
    <p class="text-xs/5 text-text-secondary">
        Type math visually. Use / for fractions, ^ for powers, and Space to
        leave a fraction or exponent.
    </p>
    {#if loading}<p role="status" class="text-xs text-text-muted">
            Loading equation editor…
        </p>{/if}
    <div
        class="min-h-16 overflow-x-auto rounded-md border border-control-border bg-surface px-3 py-3 text-xl text-text-primary"
    >
        <span
            bind:this={host}
            class="min-w-full border-0! bg-transparent! text-text-primary! outline-none! ring-0! shadow-none! [&_*]:border-text-primary! [&_.mq-cursor]:border-text-primary! [&_.mq-selection]:bg-selected! [&_.mq-selection_*]:bg-selected! [&_.mq-selection_*]:text-text-primary! [&_.mq-empty]:bg-hover! [&_.mq-focused]:shadow-none!"
        ></span>
    </div>
    {#if errorMessage}<p role="alert" class="text-xs/5 text-danger">
            {errorMessage}
        </p>{/if}
    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            class={primaryButton}
            disabled={loading || !latex.trim()}
            onclick={insert}>Insert equation</button
        >
        <button type="button" class={button} onclick={onCancel}>Cancel</button>
        <span class="text-xs text-text-muted"
            >Enter to insert · Esc to cancel</span
        >
    </div>
</section>
