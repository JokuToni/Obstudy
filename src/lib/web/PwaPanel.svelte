<script lang="ts">
    import { onMount } from "svelte";
    import { button, tabSection } from "$lib/components/ui/styles";

    let offline = $state(false);
    let available = $state(false);
    let cached = $state(false);
    let installed = $state(false);
    let error = $state<string | null>(null);
    let registration: ServiceWorkerRegistration | undefined;
    onMount(() => {
        offline = !navigator.onLine;
        installed =
            window.matchMedia("(display-mode: standalone)").matches ||
            !!Reflect.get(navigator, "standalone");
        let disposed = false;
        const network = () => {
            offline = !navigator.onLine;
        };
        const updateState = () => {
            if (disposed) return;
            available =
                !!registration?.waiting && !!navigator.serviceWorker.controller;
            cached = !!registration?.active;
        };
        const changed = () => {
            updateState();
            registration?.installing?.addEventListener(
                "statechange",
                updateState,
                { once: true },
            );
        };
        const onMessage = (event: MessageEvent) => {
            if (event.data?.type === "UPDATE_BLOCKED")
                error = "Close other Obstudy tabs before updating.";
        };
        // Reload only after the user requests an update from this home screen.
        let applying = false;
        const controllerChanged = () => {
            if (applying) window.location.reload();
            else updateState();
        };
        const activate = () => {
            applying = true;
            registration?.waiting?.postMessage({ type: "ACTIVATE_UPDATE" });
        };
        window.addEventListener("obstudy-apply-update", activate);
        window.addEventListener("online", network);
        window.addEventListener("offline", network);
        if ("serviceWorker" in navigator && !import.meta.env.DEV) {
            navigator.serviceWorker.addEventListener("message", onMessage);
            navigator.serviceWorker.addEventListener(
                "controllerchange",
                controllerChanged,
            );
            void navigator.serviceWorker
                .register("/service-worker.js", { updateViaCache: "none" })
                .then((value) => {
                    if (disposed) return;
                    registration = value;
                    updateState();
                    registration.addEventListener("updatefound", changed);
                    void registration.update().catch(() => {});
                })
                .catch(() => {
                    error =
                        "Offline setup failed. Reopen the app while connected to try again.";
                });
        }
        void navigator.storage?.persist?.().catch(() => {});
        return () => {
            disposed = true;
            window.removeEventListener("obstudy-apply-update", activate);
            window.removeEventListener("online", network);
            window.removeEventListener("offline", network);
            registration?.removeEventListener("updatefound", changed);
            if ("serviceWorker" in navigator) {
                navigator.serviceWorker.removeEventListener(
                    "message",
                    onMessage,
                );
                navigator.serviceWorker.removeEventListener(
                    "controllerchange",
                    controllerChanged,
                );
            }
        };
    });
</script>

<section class={[tabSection, "mb-4"]} aria-label="App availability">
    <p role="status" class="text-sm/6 text-text-muted">
        {offline
            ? "Offline · Answers stay on this device until you reconnect."
            : cached
              ? "Ready for offline practice."
              : "Connect once to prepare offline practice."}
    </p>
    {#if !installed}<p class="mt-2 text-sm/6 text-text-secondary">
            On iPhone, open Safari’s Share menu and choose Add to Home Screen.
        </p>{/if}
    {#if available}<div class="mt-3 flex flex-wrap items-center gap-2">
            <span class="text-sm">An app update is ready.</span>
            <button
                type="button"
                class={[button, "min-h-11!"]}
                onclick={() =>
                    window.dispatchEvent(new Event("obstudy-apply-update"))}
                >Update app</button
            >
        </div>{/if}
    {#if error}<p role="alert" class="mt-2 text-sm/6 text-danger">
            {error}
        </p>{/if}
</section>
