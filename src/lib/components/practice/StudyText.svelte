<script lang="ts">
    import katex from "katex";
    import "katex/dist/katex.min.css";
    import { splitStudyText } from "$lib/study/text";

    let {
        text,
        mathOnly = false,
        standaloneMath = false,
    }: {
        text: string;
        mathOnly?: boolean;
        standaloneMath?: boolean;
    } = $props();
    const segments = $derived(
        mathOnly
            ? [{ type: "math", text, display: true }]
            : splitStudyText(text, standaloneMath),
    );
</script>

<div
    class="min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere] [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1"
>
    {#each segments as segment}{#if segment.type === "math"}<span
                class={segment.display ? "block min-w-0" : ""}
                >{@html katex.renderToString(segment.text, {
                    displayMode: segment.display,
                    throwOnError: false,
                    trust: false,
                    strict: "ignore",
                    errorColor: "var(--color-danger)",
                })}</span
            >{:else if segment.type === "code"}<pre
                class="my-3 overflow-x-auto rounded-md border border-border bg-sidebar p-4 font-mono text-[13px]/5 whitespace-pre"><code
                    >{segment.text}</code
                ></pre>{:else if segment.type === "inlineCode"}<code
                class="rounded bg-sidebar px-1 font-mono text-[13px]"
                >{segment.text}</code
            >{:else}{segment.text}{/if}{/each}
</div>
