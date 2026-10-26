<script lang="ts">
    import { tick } from "svelte";
    import {
        button,
        input,
        focusRing,
        menuItem,
    } from "$lib/components/ui/styles";
    import Dropdown from "$lib/components/ui/Dropdown.svelte";
    import MathEquationEditor from "./MathEquationEditor.svelte";
    import StudyText from "./StudyText.svelte";
    import type { EquationCommand } from "$lib/math/mathquill";

    let {
        value,
        maxCharacters,
        disabled = false,
        onChange,
    }: {
        value: string;
        maxCharacters: number;
        disabled?: boolean;
        onChange: (value: string) => void;
    } = $props();
    let textarea: HTMLTextAreaElement;
    let equationEditor = $state<MathEquationEditor>();
    let equationOpen = $state(false);
    let preview = $state(false);
    let initialLatex = $state("");
    let initialCommand = $state<EquationCommand>();
    let selectionStart = 0;
    let selectionEnd = 0;
    const actions = [
        {
            label: "Equation",
            title: "Open equation editor",
            command: undefined,
        },
        {
            label: "a/b",
            title: "Insert fraction",
            command: { latex: "\\frac" },
        },
        { label: "x²", title: "Insert exponent", command: { latex: "^" } },
        {
            label: "√",
            title: "Insert square root",
            command: { latex: "\\sqrt" },
        },
    ];
    const symbols: { label: string; command: EquationCommand }[] = [
        { label: "π · Pi", command: { latex: "\\pi" } },
        { label: "θ · Theta", command: { latex: "\\theta" } },
        { label: "∞ · Infinity", command: { latex: "\\infty" } },
        { label: "∑ · Sum", command: { latex: "\\sum" } },
        { label: "≤ · Less than or equal", command: { latex: "\\le" } },
        { label: "≥ · Greater than or equal", command: { latex: "\\ge" } },
        { label: "∈ · Element of", command: { latex: "\\in" } },
        {
            label: "ℝ · Real numbers",
            command: { latex: "\\R" },
        },
    ];
    $effect(() => {
        if (disabled) equationOpen = false;
    });
    function openEquation(command?: EquationCommand): void {
        if (disabled) return;
        if (equationOpen) {
            if (command) equationEditor?.insertCommand(command);
            return;
        }
        selectionStart = textarea.selectionStart;
        selectionEnd = textarea.selectionEnd;
        initialLatex = value
            .slice(selectionStart, selectionEnd)
            .trim()
            .replace(/^\${1,2}|\${1,2}$/g, "");
        initialCommand = command;
        equationOpen = true;
    }
    async function focusAnswer(position?: number): Promise<void> {
        await tick();
        if (!textarea.isConnected || disabled) return;
        textarea.focus();
        if (position !== undefined)
            textarea.setSelectionRange(position, position);
    }
    function cancelEquation(): void {
        equationOpen = false;
        void focusAnswer();
    }
    function insertEquation(latex: string): string | null {
        if (disabled) return "This answer is no longer editable.";
        const start = Math.min(selectionStart, value.length);
        const end = Math.min(selectionEnd, value.length);
        const inserted = `$${latex}$`;
        const next = value.slice(0, start) + inserted + value.slice(end);
        if (next.length > maxCharacters)
            return `This equation would exceed the ${maxCharacters}-character answer limit. Shorten the answer or equation.`;
        onChange(next);
        equationOpen = false;
        void focusAnswer(start + inserted.length);
        return null;
    }
</script>

<div
    class="min-w-0 rounded-md border border-control-border bg-surface focus-within:border-accent"
>
    <div
        data-answer-editor-control
        aria-label="Answer editor actions"
        role="group"
        class="flex min-h-10 flex-wrap items-center gap-1 rounded-t-md border-b border-border bg-sidebar px-2 py-1"
    >
        {#each actions as action}
            <button
                type="button"
                class={[button, "border-transparent bg-transparent px-2"]}
                aria-label={action.title}
                title={action.title}
                {disabled}
                onclick={() => openEquation(action.command)}
                >{action.label}</button
            >
        {/each}
        <Dropdown id="answer-math-symbols" label="Symbols" {disabled}>
            {#snippet children(close)}
                {#each symbols as symbol}
                    <button
                        type="button"
                        class={menuItem}
                        onclick={() => {
                            close();
                            openEquation(symbol.command);
                        }}>{symbol.label}</button
                    >
                {/each}
            {/snippet}
        </Dropdown>
        <button
            type="button"
            class={[
                "ml-auto min-h-8 rounded px-2 text-xs text-text-secondary hover:bg-hover disabled:opacity-60",
                focusRing,
            ]}
            aria-pressed={preview}
            aria-label={preview ? "Hide answer preview" : "Show answer preview"}
            {disabled}
            onclick={() => {
                preview = !preview;
            }}>Preview</button
        >
    </div>
    {#if equationOpen}
        <MathEquationEditor
            bind:this={equationEditor}
            {initialLatex}
            {initialCommand}
            onInsert={insertEquation}
            onCancel={cancelEquation}
        />
    {/if}
    <textarea
        bind:this={textarea}
        id="practice-answer"
        {value}
        oninput={(event) => onChange(event.currentTarget.value)}
        {disabled}
        maxlength={maxCharacters}
        rows="6"
        placeholder="Write your answer in your own words…"
        class={[
            input,
            "block min-h-40 w-full resize-y rounded-none border-0 text-base/7 focus-visible:-outline-offset-2",
        ]}></textarea>
    {#if preview}
        <section
            aria-label="Answer preview"
            class="space-y-2 border-t border-border p-4"
        >
            <h3 class="text-xs font-medium text-text-secondary">Preview</h3>
            {#if value.trim()}<StudyText text={value} />{:else}<p
                    class="text-sm text-text-muted"
                >
                    Your answer preview will appear here.
                </p>{/if}
        </section>
    {/if}
</div>
