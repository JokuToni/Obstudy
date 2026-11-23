export const focusRing = "outline-none";
export const tabSection =
    "w-full max-w-xl rounded-lg border border-border bg-sidebar p-3 sm:p-4";
export const tabSectionHeader =
    "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border pb-3";
export const tabSectionTitle =
    "m-0 flex min-h-8 items-center text-sm/5 font-semibold";
export const button = `min-h-8 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px]/5 text-text-primary hover:bg-hover active:bg-selected disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;
export const primaryButton = `min-h-9 rounded-md bg-accent-solid px-4 py-2 text-[13px]/5 font-medium text-on-accent hover:bg-accent-solid-hover active:bg-accent-solid-hover disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;
export const input = `min-h-9 w-full min-w-0 rounded-md border border-control-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted disabled:opacity-60 outline-none focus:outline-none focus-visible:outline-none`;
export const menuItem = `flex min-h-9 w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px]/5 hover:bg-hover active:bg-selected disabled:opacity-60 ${focusRing}`;
