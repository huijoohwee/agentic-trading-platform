# Agentic Trading Platform

A device-local decision journal and Moomoo × Qoder competition rehearsal. Enter quantity, price and an explicit evaluation time, inspect the R01 freshness reason and save the observation. A tab reopens the exact accepted inputs, fixture digest and policy revision from IndexedDB. Its revision fence rejects a competing stale edit.

## Run

Use Node 22.22 or later with the local Git checkouts of Agentic Base, Sheets and Design System available. The Dev server also reads the pinned browser annotation policy from the local `agentic-commerce-os` checkout. The default owner directory is the parent of the primary trading checkout. Use `TRADING_OWNER_ROOT` for a different location.

```sh
npm run dev
```

Open [the local workspace](http://127.0.0.1:4181). Wait for **Offline ready** before disconnecting. The TEST quote is realtime at 09:00:00 UTC on 19 November 2026. At 09:05:00, R01 passes. Choose **Advance 1 s** and it fails. Save the draft, close the tab and reopen the same URL offline. The **Saved observation** section shows the recorded result. Open **Source evidence and calculation** for the input digest and an on-demand Sheets calculation.

The browser’s origin owns this private fixture. A different hostname or port opens a separate store. Clearing browser site data removes the record. The local runner serves loopback and the service worker caches only the sealed static assets. The app has no broker account, live market input or execution interface.

Open **Private cash-policy audit**, **Decision and execution log**, **Verified rule boundaries**, or **Offline schedule and run receipts** to outline its heading with the shared Design System annotation style. Closing the disclosure clears its outline. The loopback Dev document supports browser annotation overlays online and offline. Packaged builds retain their strict stylesheet policy.

## Replay the competition offline

Open **Moomoo × Qoder competition rehearsal** in the journal after **Offline ready** appears. Disconnect, select **Run A · practice** and choose **Replay run**. Open **Decision and execution log** and filter for `fill`. Select either five-share fill by click, tap, or Enter to inspect its execution price and equity. The two fills are at $24 and $26 against a $25 buy limit. The second execution breaches the limit even though the average is $25. The run also exercises an independent risk veto, a repeated trigger, cancellation after a partial fill and a halt until simulator readback.

Open the replay dashboard in the running journal using the fragment `/#replay-dashboard`. It opens the saved run, or previews Run B on a fresh device. The preview leaves the saved-run preference untouched.

The **Replay dashboard** uses the same Design System layout and cards as Graph’s Agent Mission dashboard. Its chart groups verified account equity observations by UTC date. Choose a day by touch, click or arrow keys to read the opening, high, low and closing equity. **Inspect source events** opens the Base decision log filtered to the selected date. **Export daily equity to Sheets** saves all observed dates, their four USD values and event counts. The chart measures synthetic account equity after replay events. Days without observations are omitted.

Switch worksheets with **Source records**, **Daily equity**, and **Event activity**. Source records opens the same filterable decision log. In either analysis worksheet, choose **Chart → Setup** to select a line, area, or column chart and group a measure by UTC date, event type, or decision. Daily equity also offers the equity range. **Customize** controls the series color, gridlines and value readout where applicable.

Choose **Pivot table → Fields** to select rows, an optional column dimension, a measure, and an event-type filter. **Options** controls descending row order and the grand total. First and last equity use replay sequence. Missing equity observations are blank in Sheets. Chart and pivot exports fit the current projection and retain numeric cells. Each tab remembers its settings separately for each run and worksheet.

Use **Export run to Sheets** for a read-only projection of the full run, including numeric USD equity for every event. In Agentic Sheets, import the JSON snapshot and use **Replace with imported clone** to open an independent workbook. Filtering the table leaves the export complete.

Open **59 verified rule boundaries** to filter by rule, expected result, or input. Select a boundary to inspect its original input and expected value. **Export boundaries to Sheets** includes all 59 cases in fixture order. The workbook sizes itself to the data, with one header row and one row per case. Numeric expectations stay numeric.

Choose **Export replay**, then replay **Run B · competition**. The replay dashboard shows the Friday mark of $99,992.93, final ranked equity of $100,835.37105 and later account equity of $100,934.36445. Final-day exercise is included in ranked equity. The later sale affects account equity. Reopen the page offline to see B, then choose A’s file under **Restore replay file** to reproduce A’s policy, evidence and decisions. An invalid archive leaves the last verified snapshot available. Each tab can select a run. The last successful selection is the default on reopen.

The browser and CLI use the same pinned synthetic calendar, instruments, two tapes and 59 independent rule examples. The evaluator keeps monetary totals in millionths of a USD. Dates, readbacks, reviewer roles and order effects are fixture data. These runs exercise the offline parts of VCC-24/25/27/28. Qoder session provenance, provider fee rounding, actual simulator settlement and scored competition participation require provider evidence. Each export contains fixture aliases, versioned inputs, event receipts, positions, the equity series and a digest. Restore checks its contents against the pinned fixture and replays the full run. This format accepts only the two included fixtures.

```sh
npm run rehearsal
npm run --silent rehearsal -- --export A > rehearsal-A.json
npm run rehearsal -- --restore rehearsal-A.json
```

The rehearsal loads on opening its disclosure. Its assets are in the same sealed offline cache as the journal. The rehearsal’s local storage key holds one verified archive independently of the original ticket’s IndexedDB schema. To recover the previous journal, serve its retained build at the same origin and reload after the service worker activates. Export the rehearsal first to retain a portable copy.

## Audit a private cash-policy fixture

After **Offline ready**, open **Private cash-policy audit**. The sample uses an explicitly synthetic policy and account. Each of R01–R09 passes on the draft. One fill at $26 breaches its $25 limit, and a second order has no bound ticket. The view shows the rule results, equity, reconciliation and audit head together.

Choose **Import run** to save the sample. Paste a second synthetic snapshot with a new run ID on every row to compare another policy or a halt. Base appends a verified run at the expected revision. Reopening shows the most recently accepted run. Re-importing identical evidence is idempotent. A changed payload for an existing ID or a competing write leaves the previous run readable.

**Export audit** saves the inputs, rule results, ordered audit events and local cost record. Keep **Save witness** separately. Select both files and choose **Verify and restore** to recompute the selected run and check its head and event count. A verified historical run can be inspected while the latest accepted run remains available on reopen. Treat every input here as synthetic. The fixture's policy amounts are examples. The cash-policy evaluator compares decimal products at the policy boundary. Its tests use a separate Python decimal reference. A derived total that cannot round-trip through a JSON number is reported as unknown. The full workbook requires independent qualification.

```sh
npm run audit:local
npm run audit:local -- --mock
npm run --silent audit:local -- --export > audit.json
npm run --silent audit:local -- --witness > witness.json
npm run audit:local -- --restore audit.json witness.json
```

## Rehearse a scheduled review

Under the competition rehearsal, open **Offline schedule and run receipts** before or after replaying a run. Filter the timeline by action, outcome, route, or event. Select a receipt for its UTC time, request, run, and last completed event when recorded. **Export receipts to Sheets** includes the complete timeline and the fixture request body. A manual test finishes, the first scheduled event is redelivered, a concurrent trigger skips, and a paused trigger produces no run. Unpause resumes with the last completed event. The final run can finish after the exclusive cutoff. Each method and path describes a fixture observation. Provider credits are unknown.

```sh
npm run rehearsal -- --schedule
npm run rehearsal -- --bindings
npm run package:replay
```

The second command checks the included synthetic Desktop and Cloud records. An optional JSON file in the shape of `src/binding-fixture.json` supplies redacted observations. Fields for scopes and version bindings are local review data. The checker reports expired evidence, account drift, cost gaps or changed permissions and pins. A passing comparison grants no effect authority.

For a selected upstream skill, `python3 scripts/inspect-skill.py SKILL.zip` verifies the ZIP locally and prints its digest. This optional tool uses PyYAML and markdown-it-py. It checks the single skill root, YAML identity, relative Markdown links, archive integrity and common secret or metadata files. The operator retains the upstream revision, rights decision and actual Cloud upload readback separately.

The last command produces a content-addressed ZIP in `.local-build`. It contains the sealed dashboard, two headless replays, the local audit and schedule checks, a checksum inventory and instructions for a clean copy. Building the ZIP uses Python 3 and the same source-owner checkouts as the browser build. The extracted replay needs Node and Python. Runtime credentials, judge access, the entrant's presentation and competition results are separate.

## Build and verify

```sh
npm run build
npm run check
npm run check:browser
```

The build prints the standalone static directory under `.local-build/<digest>/`. Serve its contents at one HTTP loopback or HTTPS origin for service worker support. The builder reads exact Git blobs and checks the owner inventories, licences, dependency closure and 500 kB chunk limit. Base supplies revisioned records and the table projection. Design System supplies the dashboard and control profile and the collection card stylesheet. Sheets loads when a saved observation’s calculation is opened. Its module bytes are included in the offline cache so that first use can happen disconnected.

The replay log uses the same Base browser table adapter that Graph consumes. Its disclosure and field inspector use Design System panel sections and key/type/value rows. The sealed offline build loads the table on first open.

Graph’s Agent Mission view and Trading share the executable Design System dashboard renderer. Trading passes ticket fields, the live quote-age indicator and saved evidence into its native DOM adapter. Graph uses the React adapter for the same shell and cards. The offline build verifies the renderer’s source bytes and caches them with the ticket. [Shared renderer](https://github.com/huijoohwee/agentic-design-system/blob/83de261f8f3ddf66ed41e5370b6811f498788b40/site/dashboard.mjs)

Headless tests exercise rule boundaries, evidence integrity and revision conflicts. Browser checks use Playwright with installed Chrome, two isolated contexts and two tabs per context. They stop the HTTP server and disconnect the contexts before testing persistence. Set `PLAYWRIGHT_CHANNEL` for a different installed Chromium channel. The test can reuse Playwright from the workspace Graph checkout. Automated mobile coverage uses a 360 CSS pixel touch viewport.

The governing [joined trading specification](/Users/huijoohwee/Documents/GitHub/.worktrees/joohwee/device-0232231d4a19--trading-handbook-support/undocumented-draft/prd-tad-adr-mvp-gtm-agentic-trading.md) owns the rollout sequence, later verification criteria, cost controls and recovery gates. Source rollback retains IndexedDB. If a stored schema or evidence binding is incompatible, the journal refuses to overwrite it.
