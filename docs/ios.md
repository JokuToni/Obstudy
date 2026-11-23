# iOS companion

The iOS app is a limited study client. It offers Study (due FSRS cards), Practice
(saved questions), multiple-choice and text answers, example answers, self grading,
results, resumable sessions, and local answer/history storage. Incorrect, Partly
correct, and Correct map to FSRS Again, Hard, and Good in Study mode. Practice does
not reschedule cards. Ungraded answers require confirmation before discarding.

There is no vault picker, note editing, question generation, drawing editor, or AI
credential setup on the phone. The library starts empty. The explicit sample
library allows testing without a server. Sample progress stays local and is cleared
when the first real catalog arrives; a sample cannot replace a real library.

## Development

Preview the phone UI with `npm run dev` and open
`http://localhost:1420/?mobile-preview`. Browser preview stores data in IndexedDB,
separate from desktop data. Use a narrow viewport to test the phone layout.

Native development requires macOS, full Xcode selected through `xcode-select`, an
iOS Simulator runtime or connected device, CocoaPods, and Rust targets
`aarch64-apple-ios` and `aarch64-apple-ios-sim`. The minimum supported iOS version
is 16.0. Device builds additionally require an Apple development team/signing.

```sh
npm run ios:init
npm run ios:dev
npm run ios:build
```

The generated Xcode project is `src-tauri/gen/apple/obstudy.xcodeproj`. Run init
after cloning to restore generated local support directories. The iOS Tauri config
uses `dev:ios` and `build:ios`, which select the mobile entry UI. Desktop startup,
vault access, AI integrations, and desktop plugins are excluded from the native
mobile command registration. The desktop app retains its existing behavior.

The project has been generated and the mobile frontend, browser flows, shared
scheduling logic, and native storage have been tested. Native simulator/device
execution still needs validation with full Xcode; Command Line Tools alone cannot
run `simctl` or build an iOS application.

## Storage and future syncing

`src/lib/mobile/types.ts` defines the versioned catalog and `MobileSyncTransport`
contract. Catalogs use stable note/topic/question IDs and portable question data,
without vault paths. Active sessions retain question snapshots and their original
catalog revision, so catalog updates cannot change a question mid-session.

The native app uses its private application data directory, `mobile/study.db`.
This is independent of the desktop vault database. A versioned state document is
saved with an optimistic revision check. Answers, FSRS changes, sessions, and
outgoing events are committed together; failed writes do not publish new state to
the UI. Browser preview uses an equivalent IndexedDB repository.

The server contract, accounts, and SQLite storage are implemented in `restapi/`
(see `docs/restapi.md`). Implement an HTTP `MobileSyncTransport.exchange` adapter
and pass it through the `syncTransport` prop of `MobileApp`; the existing optional
Sync button will invoke it. Server URL configuration, protected token storage,
login UI, cross-device answer ingestion, background syncing, and desktop uploads
still need app integration. No network adapter is enabled by default, so personal
desktop questions are not transferred to the phone yet.

Each exchange sends the device ID, last cursor, and unacknowledged events. It
returns a new cursor, acknowledged event IDs, and optionally a replacement catalog.
Events include question snapshots, grades, session IDs, and FSRS before/after cards
and review logs. Acknowledgements and catalog changes are persisted atomically.
Answers created during a transfer stay queued. Failed transfers keep stable event
IDs for retry. Sample events never enter this queue.

The server authenticates devices, deduplicates events by ID, acknowledges only
durably accepted events, validates schema versions, and issues catalog revisions
and cursors. It replays offline reviews by timestamp and answer ID to produce a
shared schedule. The client preserves pending local card changes until
acknowledgement and then accepts server cards. Original client review cards in
the event feed are provisional; use the server catalog as the authoritative
schedule. The app does not perform cross-device reconciliation itself.

Text and math remain available offline after catalog download. Remote HTTPS images
are not cached yet. A production synchronization design should add media caching,
retention/privacy rules, and compatibility tests between desktop and server data.

## Checks

```sh
npm run check
npm run test:unit
npm run test:ui -- tests/ui/mobile-study.spec.ts
npm run build:ios
cargo test --manifest-path src-tauri/Cargo.toml
```
