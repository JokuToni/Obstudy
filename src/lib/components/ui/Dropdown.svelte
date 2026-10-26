<script lang="ts">
    import { tick, type Snippet } from "svelte";
    import { button, focusRing } from "./styles";

    let {
        id,
        label,
        labelledBy,
        above = false,
        disabled = false,
        compact = false,
        large = false,
        toolbar = false,
        fullWidth = false,
        icon,
        children,
    }: {
        id: string;
        label: string;
        labelledBy?: string;
        above?: boolean;
        disabled?: boolean;
        compact?: boolean;
        large?: boolean;
        toolbar?: boolean;
        fullWidth?: boolean;
        icon?: Snippet;
        children: Snippet<[() => void]>;
    } = $props();
    let isOpen = $state(false);
    let root: HTMLDivElement;
    let trigger: HTMLButtonElement;
    let pointerDownInside = false;

    function closeMenu(): void {
        isOpen = false;
    }
    async function toggleMenu(): Promise<void> {
        isOpen = !isOpen;
        if (isOpen) {
            await tick();
            root.querySelector<HTMLButtonElement>(
                "[data-dropdown-content] button:not(:disabled)",
            )?.focus();
        }
    }
    function outsideClick(event: PointerEvent): void {
        pointerDownInside =
            event.target instanceof Node && root.contains(event.target);
        if (
            isOpen &&
            event.target instanceof Node &&
            !root.contains(event.target)
        )
            closeMenu();
    }
    function escapeMenu(event: KeyboardEvent): void {
        if (isOpen && event.key === "Escape") {
            event.preventDefault();
            closeMenu();
            trigger.focus();
            return;
        }
        if (!root.contains(document.activeElement)) return;
        if (!isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            void toggleMenu();
            return;
        }
        if (
            !isOpen ||
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        )
            return;
        const options = Array.from(
            root.querySelectorAll<HTMLButtonElement>(
                "[data-dropdown-content] button:not(:disabled)",
            ),
        );
        if (!options.length) return;
        event.preventDefault();
        const index = options.indexOf(
            document.activeElement as HTMLButtonElement,
        );
        const nextIndex =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : event.key === "ArrowDown"
                    ? (index + 1) % options.length
                    : (index - 1 + options.length) % options.length;
        options[nextIndex].focus();
    }
    function leaveMenu(event: FocusEvent): void {
        // macOS WebKit can move focus outside before a menu button's click.
        // Let an in-progress pointer selection reach its click handler first.
        if (pointerDownInside) return;
        if (
            event.relatedTarget instanceof Node &&
            !root.contains(event.relatedTarget)
        )
            closeMenu();
    }
</script>

<svelte:window
    onpointerdown={outsideClick}
    onpointerup={() => {
        pointerDownInside = false;
    }}
    onpointercancel={() => {
        pointerDownInside = false;
    }}
    onkeydown={escapeMenu}
/>
<div
    class={[
        "relative min-w-0",
        compact ? "h-[90%] shrink-0" : fullWidth ? "w-full" : "",
    ]}
    bind:this={root}
    onfocusout={leaveMenu}
>
    <button
        bind:this={trigger}
        type="button"
        class={compact
            ? `h-full w-6 rounded text-xs text-text-secondary hover:bg-hover ${focusRing}`
            : toolbar
              ? `flex h-10 w-full items-center gap-2 rounded-md border border-control-border bg-surface px-3 text-[13px]/5 hover:bg-hover disabled:opacity-60 ${focusRing}`
              : large
                ? `flex min-h-12 w-full items-center gap-3 rounded-md border border-control-border bg-surface bg-none px-4 py-3 text-sm hover:bg-hover disabled:opacity-60 ${focusRing}`
                : `${button} flex ${fullWidth ? "w-full" : "max-w-44"} items-center gap-2`}
        aria-labelledby={labelledBy}
        aria-label={compact ? "Open a tab" : label}
        {disabled}
        aria-expanded={isOpen}
        aria-controls={id}
        onclick={toggleMenu}
    >
        {#if icon}{@render icon()}{/if}
        <span class="min-w-0 flex-1 truncate text-left">{label}</span>
        {#if !compact}<svg
                class="size-3 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
                ><path d={above ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg
            >{/if}
    </button>
    {#if isOpen}
        <div
            {id}
            data-dropdown-content
            class={[
                "absolute right-0 z-50 max-h-[60dvh] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-surface bg-none p-2 shadow-xl",
                fullWidth ? "w-full" : large ? "w-80" : "w-64",
                above ? "bottom-full mb-2" : "top-full mt-1",
            ]}
        >
            {@render children(closeMenu)}
        </div>
    {/if}
</div>
