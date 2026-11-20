# Agentic Trading Platform

A device-local decision journal and Moomoo × Qoder competition rehearsal. Enter quantity, price and an explicit evaluation time, inspect the R01 freshness reason and save the observation. A tab reopens the exact accepted inputs, fixture digest and policy revision from IndexedDB. Its revision fence rejects a competing stale edit.

## Run

Use Node 22.22 or later with the local Git checkouts of Agentic Base, Sheets, Design System and Agentic OS available. The Dev server also reads the pinned browser annotation policy from the local `agentic-commerce-os` checkout. The default owner directory is the parent of the primary trading checkout. Use `TRADING_OWNER_ROOT` for a different location.

```sh
npm run dev
```

Open [the local workspace](http://127.0.0.1:4181). Wait for **Offline ready** before disconnecting. The TEST quote is realtime at 09:00:00 UTC on 19 November 2026. At 09:05:00, R01 passes. Choose **Advance 1 s** and it fails. Save the draft, close the tab and reopen the same URL offline. The **Saved observation** section shows the recorded result. Open **Source evidence and calculation** for the input digest and an on-demand Sheets calculation.

The browser’s origin owns this private fixture. A different hostname or port opens a separate store. Clearing browser site data removes the record. The default local runner serves loopback and the service worker caches only sealed static assets. Runtime readback is separately configured; the browser never receives broker credentials or an execution interface.

Open **Skills & Commands** for the **Agentic Trading Skills** FloatingPanel. It reuses the centralized Design System shell, catalog filters, grouping, layouts and keyboard controls, following Graph's shared-owner pattern without copying Graph handlers. Its four read-only entries come from the pinned Agentic OS catalog: `/skill.discover`, `/skill.load`, `#read-only` and `@skill:trading`. The verified skill instructions are available offline. This reference does not invoke commands, install provider skills or grant trading authority.

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

## Isolated local runtime

The `runtime/` modules implement durable local contracts, not proof that Desktop, Cloud, a provider account or the competition is ready. No connector installation, OAuth, paid operation, Skill upload, Schedule activation or paper order is performed by building or testing this repository. Actual-provider qualification remains **UNQUALIFIED**. There is no LIVE path, browser order control or automatic retry of an uncertain submission.

Use one authoritative SQLite database and stable aliases for each physical account. SQLite WAL/FULL transactions fence concurrent writers; events and cursors commit together. The paper guard coordinates both profiles through the alias's practice row while retaining each record's true scope. Read and paper calls share a cost-proof allowance in a reserved `runtime-budget/` account row. A read reserves its entire admitted maximum before contacting the adapter; unused reservations are not refunded. A new nonce cannot reset an exhausted proof. Failed setup records actual calls as unknown, not zero. Database capacities fail closed rather than dropping history. After a crash, an operator-signed `read-recovery` permit can interrupt an abandoned import without refunding its budget or replacing the accepted snapshot: `npm run runtime -- recover-read /absolute/private/config.json /absolute/private/recovery.json`. The permit binds the original `run_id`, a one-use nonce and `import_binding` (SHA-256 of the canonical original signed read envelope). Start any subsequent read with a new run/grant; recovery never resumes outbound calls.

Keep the database, configuration, private keys, OAuth token and grants in an operator-owned mode-0700 directory with mode-0600 files, outside shared Cloud Agent storage. `.runtime-private/` is ignored if a local checkout directory is used. Do not place these files in a Skill ZIP or the browser output. Configuration paths must be absolute; the runner never loads executable modules from configuration.

`runtime/config.mjs` accepts `trading-runtime-config/v1` with `database` (a simple `.sqlite` filename), exact `scope` (`environment: SIMULATE`, `profile: practice|competition`, `account_alias`), a SHA-256 `candidate`, and trusted `keys`. Key records bind `role`, `principal`, `runtime`, an Ed25519 public PEM and optional `revoked`. `viewer_token` is a separate local secret of at least 32 characters, never the broker token. `moomoo`, when deliberately configured, contains `token`, `mapping`, `attestation` and `alias_secret`; none is exported.

```sh
npm run runtime -- inspect /absolute/private/config.json
npm run runtime -- serve /absolute/private/config.json 4181
npm run runtime -- configuration /absolute/private/bound-forward.json
npm run runtime -- telemetry /absolute/private/config.json /absolute/private/permit.json /absolute/private/observation.json /absolute/private/bound-forward.json
```

Open **Runtime readback** in the same loopback origin, enter the local viewer token and choose **Read local runtime**. Its authenticated GET exposes a redacted projection only. The token is cleared after each attempted read, including failures, and is never persisted. Base stores the last validated observation independently from execution state; offline use is labelled as stored evidence. Unknown equity, FX or usage stays unknown. Observed-mark drawdown is not an official competition result. Completion, delivery, main-session coverage and child-thread usage remain distinct. Corrupt data, failed reads and competing tab saves do not replace the last accepted observation.

### Authenticated market/account reads

Only the following explicitly invoked command contacts Moomoo; do not run it before provider rights, account identity, runtime isolation and a zero-cost deny-at-exhaustion allowance have been independently reviewed.

```sh
npm run runtime -- read /absolute/private/config.json reviewed-run-id /absolute/private/read-grant.json
```

The adapter uses the fixed official MCP origin, initialization/version negotiation and an exact pinned `tools/list` descriptor digest. Four reviewed read tools map into `IN_Quotes`, `IN_Positions`, `IN_Balance` and `IN_Orders`. No tool-name guessing, account fallback, redirect, reconnect or mutation method is provided. `mapping.protocol`, `mapping.account_identity` and each `mapping.sheets` entry must be supplied from reviewed provider evidence. Each entry names `tool`, `parameters`, `rows_path`, explicit `fields` projections and, for account data, `account_path`; optional pagination uses `cursor_parameter`, `limit_parameter` and `next_path`. Decimal fields must arrive as exact strings. Unsupported numeric wire representations or lost precision fail closed.

All envelopes use `{key_id,payload,signature}` with canonical-JSON Ed25519 signatures. Payloads bind schema `trading-runtime-envelope/v1`, kind, principal, runtime, exact scope, candidate, issued/expiry UTC and operation-specific content. A `read` operator grant carries nonce, `mapping_digest`, the four `{sheet,name,schema_digest,effect:read}` bindings, limits (`max_calls` at most 12, timeout at most ten minutes), current cost/rights/account proofs and an explicit zero-dollar budget. The integration signing identity and secret stay outside the browser. Reference fixtures in `test/runtime-ingestion.test.mjs` are generated MOCK evidence, not reusable operational approvals.

### Independent paper guard and reconciliation

`createPaperGuard({store,scope,candidate,keys,broker,now})` exposes host-only `release({intent,grant,review})`, `reconcile({intent_id,grant})` and `halt({grant,reason})`. There is intentionally no real broker transport or paper-dispatch CLI in this implementation: wire-level cutoff enforcement, provider semantics, account qualification and a separately authorized practice canary remain release gates.

The trusted broker contract supplies signed `provider-observation` envelopes from `readAccount`, `submit` and `readOrder`. Account evidence binds source/provider, snapshot identity/time, CASH/USD account state, zero margin/short exposure, cash/equity/day P&L, daily count, an all-fill fee upper bound, complete positions/quotes/instruments/calendar/FX, open orders and accounted terminal order IDs. Cash includes fills but excludes local working-order reservations. `submit` receives the exact intent/ticket and `not_after_utc`, which must be enforced at actual wire handoff. Order evidence binds immutable broker/intent IDs, symbol, side, quantity, limit, state and cumulative immutable individual fills. An acknowledgement, absent order or average price never substitutes for authenticated fill evidence.

An intent binds research identity, exact account input, policy, strategy and evaluator digests plus its LIMIT ticket. The evaluator digest covers actual guard, authorization, storage and rule source bytes. Operator `paper` grants and independent `risk` reviews bind the identical intent/input/policy/strategy/evaluator tuple. Grants include current cost/rights/account/isolation proofs, source (`MOCK` or `PROVIDER`), provider, actions, notional/time limits and exclusive cutoff. Reviews require `APPROVE` and a one-use nonce. The host key registry, not caller labels, establishes independence. Host-owned `configs.paper` can fence a candidate or revoke digests/nonces. Initial operation is cash-only STOCK/ETF, BUY-open or SELL-close; short, margin and options are rejected.

The fixed local evaluation categories are exercised by `npm run check:runtime`: EV-01 eligible admission, EV-02 independent veto, EV-03 missing/stale evidence, and EV-04 duplicate/concurrent/uncertain/restart delivery. The paper tests always label evidence MOCK. Any unresolved release reserves capacity and halts new dispatch across restart; only signed broker readback can resolve it. Reconciliation is read-only and never resubmits an order. Run the four evaluations again after changing relevant pins or authority boundaries, then repeat them in the separately qualified provider environment.

### Forward bindings and Skill packages

`runtime/roles.json` is an unbound, non-executable local template for coordinator, research, risk, executor and advisor. `validateConfiguration`, `diffConfiguration` and `provenanceProjection` preserve whole arrays, numeric child-Agent versions, opaque Skill versions, resource/effective hashes and reviewer-isolation evidence. Compiled effective observations are not writable DSL. The read client implements only the documented effective-template and Schedule Run GETs with bounded responses and server-injected PATs; it never creates or activates schedules. Local telemetry ingestion requires independent signatures over the exact batch, configuration and expected cursor. Main-session evidence cannot stand in for child-thread streams. No fabricated Cloud configuration is written into AGENTS.md.

```sh
npm run package:skill -- --source /absolute/source.zip --review /absolute/review.json --output /absolute/output.zip
```

Packaging requires optional, separately installed **PyYAML and markdown-it-py** and fails closed when absent. It does not install dependencies, execute source code or upload anything. The `skill-package-review/v1` review supplies exact upstream revision, compressed source digest, complete file inventory, selected skill path/name, reviewed rights/runtime evidence with local digests, explicit relocation mapping and byte-offset link edits. Tree input additionally requires its unchanged retained `--source-archive`. Only the selected `SKILL.md` and references/scripts/assets are packaged. The deterministic ZIP and immutable sidecar record provenance and reviewed link diffs; neither grants runtime authority. Examples of review shape and rejection cases are in `test/skill-package.test.mjs`.

## Build and verify

```sh
npm run build
npm run check
npm run check:browser
npm run check:runtime
npm run check:runtime-browser
```

The build prints the standalone static directory under `.local-build/<digest>/`. Serve its contents at one HTTP loopback or HTTPS origin for service worker support. The builder reads exact Git blobs and checks the owner inventories, licences, dependency closure and 500 kB chunk limit. Base supplies revisioned records and the table projection. Design System supplies the dashboard and control profile and the collection card stylesheet. Sheets loads when a saved observation’s calculation is opened. Its module bytes are included in the offline cache so that first use can happen disconnected.

The replay log uses the same Base browser table adapter that Graph consumes. Its disclosure and field inspector use Design System panel sections and key/type/value rows. The sealed offline build loads the table on first open.

Graph’s Agent Mission view and Trading share the executable Design System dashboard renderer. Trading passes ticket fields, the live quote-age indicator and saved evidence into its native DOM adapter. Graph uses the React adapter for the same shell and cards. The offline build verifies the renderer’s source bytes and caches them with the ticket. [Shared renderer](https://github.com/huijoohwee/agentic-design-system/blob/83de261f8f3ddf66ed41e5370b6811f498788b40/site/dashboard.mjs)

Headless tests exercise rule boundaries, evidence integrity and revision conflicts. Browser checks use Playwright with installed Chrome, two isolated contexts and two tabs per context. They stop the HTTP server and disconnect the contexts before testing persistence. Set `PLAYWRIGHT_CHANNEL` for a different installed Chromium channel. The test can reuse Playwright from the workspace Graph checkout. Automated mobile coverage uses a 360 CSS pixel touch viewport.

The approved [trading specification](/Users/huijoohwee/Documents/GitHub/.worktrees/joohwee/device-0232231d4a19--trading-runtime-readiness/undocumented-draft/prd-tad-adr-mvp-gtm-agentic-trading.md) and [Skills specification](/Users/huijoohwee/Documents/GitHub/.worktrees/joohwee/device-0232231d4a19--trading-runtime-readiness/undocumented-draft/prd-tad-adr-mvp-gtm-agentic-trading-skills.md) own the rollout sequence, runtime qualification criteria, cost controls and recovery gates. Source rollback retains IndexedDB. If a stored schema or evidence binding is incompatible, the journal refuses to overwrite it.
