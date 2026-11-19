# Agentic Trading Platform

A local decision journal for a synthetic limit ticket. Enter quantity, price and an explicit evaluation time, inspect the R01 freshness reason and save the observation. A tab reopens the exact accepted inputs, fixture digest and policy revision from IndexedDB. Its revision fence rejects a competing stale edit.

## Run

Use Node 22.22 or later with the local Git checkouts of Agentic Base, Sheets and Design System available. The default owner directory is the parent of the primary trading checkout. Use `TRADING_OWNER_ROOT` for a different location.

```sh
npm run dev
```

Open [the local workspace](http://127.0.0.1:4181). Wait for **Offline ready** before disconnecting. The TEST quote is realtime at 09:00:00 UTC on 19 November 2026. At 09:05:00, R01 passes. Choose **Advance 1 s** and it fails. Save the draft, close the tab and reopen the same URL offline. The **Saved observation** section shows the recorded result. Open **Source evidence and calculation** for the input digest and an on-demand Sheets calculation.

The browser’s origin owns this private fixture. A different hostname or port opens a separate store. Clearing browser site data removes the record. The local runner serves loopback and the service worker caches only the sealed static assets. The app has no broker account, live market input or execution interface.

## Build and verify

```sh
npm run build
npm run check
npm run check:browser
```

The build prints the standalone static directory under `.local-build/<digest>/`. Serve its contents at one HTTP loopback or HTTPS origin for service worker support. The builder reads exact Git blobs and checks the owner inventories, licences, dependency closure and 500 kB chunk limit. Base supplies revisioned records and the table projection. Design System supplies the dashboard and control profile and the collection card stylesheet. Sheets loads when a saved observation’s calculation is opened. Its module bytes are included in the offline cache so that first use can happen disconnected.

The journal uses the native HTML dashboard contract from the same Design System revision as Graph’s Agent Mission manifest view. The shared styles lay out the header, responsive card grid and evidence disclosure. Trading supplies the ticket fields, freshness verdict and saved observation. [Design System contract](https://github.com/huijoohwee/agentic-design-system/blob/fd18c30f7820bace18b450f9fc40206392c0de28/README.md) · [Graph reference view](https://github.com/huijoohwee/agentic-graph/blob/9bfc5d2c08dbb026d41cba29ddb46255a84f1b16/canvas/src/features/agent-ready/AgentMissionDashboardView.tsx)

Headless tests exercise rule boundaries, evidence integrity and revision conflicts. Browser checks use Playwright with installed Chrome, two isolated contexts and two tabs per context. They stop the HTTP server and disconnect the contexts before testing persistence. Set `PLAYWRIGHT_CHANNEL` for a different installed Chromium channel. The test can reuse Playwright from the workspace Graph checkout. Automated mobile coverage uses a 360 CSS pixel touch viewport.

The governing [joined trading specification](/Users/huijoohwee/Documents/GitHub/.worktrees/joohwee/device-0232231d4a19--trading-platform-plan/undocumented-draft/prd-tad-adr-mvp-gtm-agentic-trading.md) owns the rollout sequence, later verification criteria, cost controls and recovery gates. Source rollback retains IndexedDB. If a stored schema or evidence binding is incompatible, the journal refuses to overwrite it.
