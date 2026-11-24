<script lang="ts">
    import AccountPanel from "./AccountPanel.svelte";
    import {
        desktopAccount,
        connectDesktopAccount,
        disconnectDesktopAccount,
        syncDesktopAccount,
    } from "./desktopController";
</script>

<AccountPanel
    session={$desktopAccount.session}
    onConnected={connectDesktopAccount}
    onDisconnected={disconnectDesktopAccount}
    onSync={syncDesktopAccount}
    syncing={$desktopAccount.syncing}
    lastSync={$desktopAccount.lastSync}
    syncError={$desktopAccount.error}
/>
