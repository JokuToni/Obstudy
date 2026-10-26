<script lang="ts">
    import { onMount, tick } from "svelte";
    import {
        Annotation,
        Compartment,
        EditorState,
        Prec,
    } from "@codemirror/state";
    import {
        EditorView,
        keymap,
        placeholder,
        drawSelection,
    } from "@codemirror/view";
    import {
        defaultKeymap,
        history,
        historyKeymap,
    } from "@codemirror/commands";
    import { answerMath, findAnswerEquations } from "$lib/math/answerEditor";
    import { button, menuItem } from "$lib/components/ui/styles";
    import Dropdown from "$lib/components/ui/Dropdown.svelte";
    import MathEquationEditor from "./MathEquationEditor.svelte";
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
    let host: HTMLDivElement;
    let view = $state.raw<EditorView>();
    const readOnly = new Compartment();
    const externalUpdate = Annotation.define<boolean>();
    let limitError = $state<string | null>(null);
    let displayEquation = false;
    let equationEditor = $state<MathEquationEditor>();
    let equationOpen = $state(false);
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
    function editRenderedEquation(target: EventTarget | null): boolean {
        const widget =
            target instanceof Element
                ? target.closest<HTMLElement>("[data-answer-equation]")
                : null;
        if (!widget || disabled || !view) return false;
        view.dispatch({
            selection: {
                anchor: Number(widget.dataset.from),
                head: Number(widget.dataset.to),
            },
        });
        openEquation();
        return true;
    }
    onMount(() => {
        view = new EditorView({
            parent: host,
            state: EditorState.create({
                doc: value,
                extensions: [
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    drawSelection(),
                    EditorView.lineWrapping,
                    placeholder("Write your answer in your own words…"),
                    answerMath,
                    readOnly.of([
                        EditorState.readOnly.of(disabled),
                        EditorView.editable.of(!disabled),
                    ]),
                    EditorView.contentAttributes.of((editor) => ({
                        id: "practice-answer",
                        role: "textbox",
                        "aria-label": "Your answer",
                        "aria-multiline": "true",
                        "aria-readonly": String(editor.state.readOnly),
                        "data-answer-input": "",
                    })),
                    EditorState.transactionFilter.of((transaction) => {
                        if (
                            transaction.docChanged &&
                            !transaction.annotation(externalUpdate) &&
                            transaction.newDoc.length > maxCharacters
                        ) {
                            limitError = `Answers can contain at most ${maxCharacters} characters, including equation LaTeX.`;
                            return [];
                        }
                        return transaction;
                    }),
                    EditorView.updateListener.of((update) => {
                        if (!update.docChanged) return;
                        limitError = null;
                        if (
                            !update.transactions.some((transaction) =>
                                transaction.annotation(externalUpdate),
                            )
                        )
                            onChange(update.state.doc.toString());
                    }),
                    Prec.high(
                        EditorView.domEventHandlers({
                            mousedown: (event) => {
                                if (editRenderedEquation(event.target)) {
                                    event.preventDefault();
                                    return true;
                                }
                                return false;
                            },
                            keydown: (event) => {
                                if (
                                    (event.key === "Enter" ||
                                        event.key === " ") &&
                                    editRenderedEquation(event.target)
                                ) {
                                    event.preventDefault();
                                    return true;
                                }
                                return false;
                            },
                        }),
                    ),
                ],
            }),
        });
        return () => view?.destroy();
    });
    $effect(() => {
        const editor = view;
        if (!editor) return;
        if (editor.state.doc.toString() !== value)
            editor.dispatch({
                changes: {
                    from: 0,
                    to: editor.state.doc.length,
                    insert: value,
                },
                annotations: externalUpdate.of(true),
            });
        if (editor.state.readOnly !== disabled)
            editor.dispatch({
                effects: readOnly.reconfigure([
                    EditorState.readOnly.of(disabled),
                    EditorView.editable.of(!disabled),
                ]),
            });
        if (disabled) equationOpen = false;
    });
    export function focusToEnd(): void {
        if (!view || disabled) return;
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.focus();
    }
    export function isAtEnd(): boolean {
        return (
            !!view &&
            view.state.selection.main.empty &&
            view.state.selection.main.head === view.state.doc.length
        );
    }
    function openEquation(command?: EquationCommand): void {
        if (disabled || !view) return;
        if (equationOpen) {
            if (command) equationEditor?.insertCommand(command);
            return;
        }
        const selection = view.state.selection.main;
        selectionStart = selection.from;
        selectionEnd = selection.to;
        const selected = view.state.sliceDoc(selectionStart, selectionEnd);
        const equation = findAnswerEquations(view.state.doc.toString()).find(
            (range) =>
                range.from === selectionStart && range.to === selectionEnd,
        );
        initialLatex = equation?.latex ?? selected.trim();
        displayEquation = equation?.display ?? false;
        initialCommand = command;
        equationOpen = true;
    }
    async function focusAnswer(position?: number): Promise<void> {
        await tick();
        if (!view || disabled || !view.dom.isConnected) return;
        if (position !== undefined)
            view.dispatch({ selection: { anchor: position } });
        view.focus();
    }
    function cancelEquation(): void {
        equationOpen = false;
        void focusAnswer();
    }
    function insertEquation(latex: string): string | null {
        if (disabled || !view) return "This answer is no longer editable.";
        const delimiter = displayEquation ? "$$" : "$";
        const inserted = `${delimiter}${latex}${delimiter}`;
        const start = Math.min(selectionStart, view.state.doc.length);
        const end = Math.min(selectionEnd, view.state.doc.length);
        if (
            view.state.doc.length - (end - start) + inserted.length >
            maxCharacters
        )
            return `This equation would exceed the ${maxCharacters}-character answer limit. Shorten the answer or equation.`;
        view.dispatch({
            changes: { from: start, to: end, insert: inserted },
            selection: { anchor: start + inserted.length },
            userEvent: "input",
        });
        equationOpen = false;
        void focusAnswer();
        return null;
    }
</script>

<div class="min-w-0 rounded-md border border-control-border bg-surface">
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
    <div
        bind:this={host}
        class="min-h-40 [&_.cm-editor]:min-h-40 [&_.cm-editor]:max-h-[clamp(10rem,32dvh,20rem)] [&_.cm-editor]:overflow-hidden [&_.cm-editor]:bg-transparent [&_.cm-editor]:text-text-primary [&_.cm-focused]:outline-none! [&_.cm-scroller]:min-h-0 [&_.cm-scroller]:max-h-[clamp(10rem,32dvh,20rem)] [&_.cm-scroller]:overflow-auto! [&_.cm-scroller]:font-sans! [&_.cm-content]:min-h-40 [&_.cm-content]:px-3! [&_.cm-content]:py-2! [&_.cm-content]:text-base/7! [&_.cm-content]:outline-none! [&_.cm-line]:px-0! [&_.cm-cursor]:border-text-primary! [&_.cm-selectionBackground]:bg-selected! [&_.cm-placeholder]:text-text-muted"
    ></div>
    {#if limitError}<p
            role="alert"
            class="border-t border-border px-3 py-2 text-xs/5 text-danger"
        >
            {limitError}
        </p>{/if}
</div>
