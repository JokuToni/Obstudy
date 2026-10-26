<script lang="ts">
    import type { AiProvider } from "$lib/types/ai";
    let { provider, large = false }: { provider: AiProvider; large?: boolean } =
        $props();
</script>

<img
    src={`/providers/${provider === "openaiOauth" ? "openai" : provider}.svg`}
    alt=""
    aria-hidden="true"
    class={["shrink-0 dark:invert", large ? "size-7" : "size-5"]}
/>
