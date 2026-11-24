# Agentic Trading Platform

A device-local decision journal and Moomoo × Qoder competition rehearsal. Enter quantity, price and an explicit evaluation time, inspect the R01 freshness reason and save the observation. A tab reopens the exact accepted inputs, fixture digest and policy revision from IndexedDB. Its revision fence rejects a competing stale edit.

## Run

Use Node 22.22 or later with the local Git checkouts of Agentic Base, Sheets, Design System and Agentic OS available. The Dev server also reads the pinned browser annotation policy from the local `agentic-commerce-os` checkout. The default owner directory is the parent of the primary trading checkout. Use `TRADING_OWNER_ROOT` for a different location.

```sh
npm run dev
```

Open [the local workspace](http://127.0.0.1:4181). Wait for **Offline ready** before disconnecting. The TEST quote is realtime at 09:00:00 UTC on 19 November 2026. At 09:05:00, R01 passes. Choose **Advance 1 s** and it fails. Save the draft, close the tab and reopen the same URL offline. The **Saved observation** section shows the recorded result. Open **Source evidence and calculation** for the input digest and an on-demand Sheets calculation.

The browser’s origin owns this private fixture. A different hostname or port opens a separate store. Clearing browser site data removes the record. The default local runner serves loopback and the service worker caches only sealed static assets. Runtime readback is separately configured; broker credentials remain in the host runtime.

Both pages share a toolbar and base stylesheet. **Open paper trading desk** and **Decision journal** switch pages. **Skills & Commands** opens the **Agentic Trading Skills** FloatingPanel on the current page. It reuses the centralized Design System shell, catalog filters, grouping, layouts and keyboard controls, following Graph's shared-owner pattern without copying Graph handlers. Its four read-only entries come from the pinned Agentic OS catalog: `/skill.discover`, `/skill.load`, `#read-only` and `@skill:trading`. The verified skill instructions are available offline. This reference does not invoke commands, install provider skills or grant trading authority.

Open **Private cash-policy audit**, **Decision and execution log**, **Verified rule boundaries**, or **Offline schedule and run receipts** to outline its heading with the shared Design System annotation style. Closing the disclosure clears its outline. The loopback Dev document supports browser annotation overlays online and offline. Packaged builds retain their strict stylesheet policy.

## Paper trading desk

From the decision journal, select **Open paper trading desk**. The chart, market replay and calculations run in first-party code. The default venue has 24 synthetic USD instruments and twelve UTC intervals, including 10m and 3h. The selector also discovers markets installed by the local operator. The footer identifies the venue, data time and transport. The order book and tape show depth, spread, bid/ask pressure and aggressor direction where the source supplies them. Historical pools expose closed candles and volume.

The anonymous account starts with 100,000 paper USD. Choose spot or perpetual before entering a market, limit or stop order. Perpetuals have signed quantities, average entry, margin, fees, realized and open P&L, funding records and a 2× gross leverage ceiling. Reduce-only permits closing part or all of an existing position. The guard rechecks working orders when their selected market is open, and checks observed USD marks and funding continuity before a public-market paper fill. The replay venue models eight-hour funding. The fee estimate is 0.10%. Portfolio and journal exports use Base record views and Sheets workbook generation.

Trading 0.14.0 publishes two landing actions and 22 desk actions for Skills 0.10.0. The normal browser controls work on desktop and mobile. On a WebMCP host the top document registers the same actions and validation, and tears down registrations at navigation. From loopback, obtain a session cookie with `GET /api/practice/session`, then read `GET /api/practice/capabilities`. The JSON gateway and MCP endpoints use the same owner session. Paper changes bind direct intent, a request ID and the observed revision. Reuse that binding to resolve an uncertain submission. Reset requires **RESET PAPER SESSION**.

The local server saves to SQLite in `.runtime-private/desk`. Base caches the accepted session on the device. Schema v2 loads existing v1 paper balances, orders, fills and preferences. The chart and strategy editor work offline on sealed synthetic bars. Saves require the local server. Session receipts cap at 10,000, serialized state at 480,000 bytes, and fills and equity samples at 1,000 each. Before source rollback, stop the server and retain the private directory, including its SQLite WAL files. Serve the previous sealed build with its matching pre-upgrade data copy. Keep the current directory for reviewed recovery of later paper entries.

### Install public historical observations

The optional importer reads the CC BY 4.0 Uniswap v3 hourly archive by Zhou, Liu and Brini. It pins the 14.3 MB Parquet file by SHA-256, excludes publisher-marked missing observations and writes verified UTC partitions under 500 kB. The installer exposes six spot instrument bindings across four 0.05% pools. Prices use the displayed quote unit and volume uses the displayed base unit. Install before opening the desk, or restart the local server to reload the catalog. [Dataset and attribution](https://zenodo.org/records/17302324)

```sh
uv run --isolated --with duckdb==1.4.4 python scripts/import-pool-history.py
# With a retained copy of the original, both commands work without a data connection.
uv run --isolated --with duckdb==1.4.4 python scripts/import-pool-history.py --file /path/to/pool_hourly_data.parquet
uv run --isolated --with duckdb==1.4.4 node scripts/check-pool-history.mjs .runtime-private/desk /path/to/pool_hourly_data.parquet
```

The final command rebuilds a directional WETH/USDC experiment and a three-pool monthly rotation against WETH, then recomputes their prices, fills or rebalances and returns independently from the publisher's bytes. The rotation uses WBTC, USDC and DAI as its explicit alternate basket. Results include missing-data warnings and are denominated in WETH. Both checks retain a cold artifact and a separate cache receipt.

### Connect a public market collector

An operator can publish snapshots from a rights-reviewed collector to the existing desk. Store a `public-market-admission/v1` manifest in `feed/admission.json` under the private desk directory. Each entry in `markets` names the venue, symbol, instrument type, quote currency, source, creator, licence, expiry in UTC milliseconds and SHA-256 of its local display-rights receipt. Use `marketType` of `spot` or `perpetual`, `hardCapUsd: 0` and `allowPublicDisplay: true`. Perpetuals also require the settlement currency. Place the reviewed receipt bytes at `feed/<rightsDigest>.rights`.

```sh
npm run market:snapshot -- .runtime-private/desk /private/collector-snapshot.json
```

The optional CCXT reader can collect one snapshot directly with `uv run --isolated --with ccxt==4.5.93 python scripts/collect-public-market.py .runtime-private/desk VENUE BASE.QUOTE spot`. Its admission entry also needs a reviewed `collector` mapping with the CCXT exchange ID (`exchange`), unified `instrument`, exact HTTPS `hosts`, `tradeSide` of maker or taker, `amountUnit` of contracts or base, and `candleVolumeUnit` of base. The reader allows 24 public GETs per invocation and requires exchange timestamps for quotes and books. It collects spot and linear perpetual market observations. External paper contracts additionally require settled funding evidence from a collector that supplies that history. The CCXT software licence and the exchange's display rights have separate receipts. [CCXT market data methods](https://github.com/ccxt/ccxt/wiki/Manual)

The full-feed collector publishes a `public-market-snapshot/v1` with the same market binding, monotone sequence, UTC timestamp, ticker, at least 20 ordered bids and asks, aggressor-tagged trades, and timestamped OHLCV candles by interval. Perpetual positions need the covered funding interval and settled events. The runtime checks the snapshot before advancing its SQLite head. Observations older than 15 seconds are stale. The local conformance test contains a complete fixture for the schema. Public live-feed qualification requires current source rights and matching observations from the chosen venue. [Snapshot contract and examples](test/public-market-feed.test.mjs)

### Strategies and historical research

The strategy editor runs a bounded Python subset in an isolated five-second worker. It accepts named functions, closed OHLCV candles, supported math and statistics imports and one-dimensional array operations. **Save version** stores a named source hash. The discovered package inventory lists each supported function. Signals overlay the chart. Prediction entries record the observed quote, horizon and owner hypothesis.

Queue one historical hypothesis or all 20. Supply the venue, UTC date range and starting capital in quote units. The default spans January 2021 through the last completed UTC month. The worker models execution costs, returns a run ID, recovers queued jobs after restart and enforces 30 new runs per owner in a rolling 24 hours. Poll for status, cancel an active job, select the matching chart to display its markers, or download the verified gzip artifact. Each completed calculation stores its parameters, data manifest, equity history, signals, trades or rebalances, costs, UTC annual and walk-forward windows, and an independent scientific hash. Unavailable datasets produce a reason and unknown return. The complete suite includes a row for each hypothesis even when individual markets are unavailable.

**Get 24-hour observer link** opens a read-only session view. An optional HTTPS listener uses `TRADING_OBSERVER_HOST`, `TRADING_OBSERVER_PORT`, `TRADING_OBSERVER_CERT` and `TRADING_OBSERVER_KEY` to share that view on a device-reachable address. The owner and artifact routes stay on loopback.

### Qualification of the 0.14.0 source release

| Check | Evidence available in this release |
|---|---|
| Trading VCC-40 | A rights-identified historical source was imported. Live-feed conformance covers 20 levels, aggressor volume, moving candles, UTC aggregation, stale snapshots and sequence rollback. Real public spot and perpetual feed receipts remain open. |
| Trading VCC-41/42 and Skills VCC-15/18 | Migration, signed paper positions, risk and funding, timeout replay after page reload, strict tool schemas, two landing actions and all 22 desk actions passed locally. The desk test replayed the same request bindings across the browser, UI gateway and MCP. The WebMCP host used in tests implements the browser registration contract. |
| Trading VCC-43 and Skills VCC-16 | Local read-only scope, expiry, reconnect and simulator coverage exist. Physical-device acceptance was deferred. |
| Trading VCC-44/45 and Skills VCC-17 | Versioned source, bounded Python workers, quota, recovery, cancellation and overlays passed. Independent DuckDB checks on the original hourly data reproduced five directional trades and eight portfolio rebalances over 906 marked days. These use explicitly selected alternate spot instruments. |
| Trading VCC-46 | Cold and warm runs agreed on scientific hashes and retained independent provenance. Integrity checks rejected corrupt data. The default 20-row suite against the installed archive reports missing canonical inputs with unknown returns. Qualified perpetual, liquidation, tick-depth and options histories are outstanding. |

### Historical qualification on the current worktree

The March 23, 2025 UTC perpetual session is derived from 474,628 executions across 21 native contracts. The source archive includes minute open interest and individual liquidation prints. One hour of the BTC book contains 6,446 top-ten snapshots and 4,007 timestamped prints. Archive ordinals distinguish simultaneous trades. The median book interval was 550 ms. The four latency scenarios fill at the next observed executable quote. [AWS Public Blockchain Data, accessed November 21, 2026](https://registry.opendata.aws/aws-public-blockchain/)

The October 2026 Ironflow vintage adds 302,064 hourly candles, 292,605 settled funding observations, 276,696 open-interest readings and 40,146 timestamp-grouped liquidation observations. The 68 input files have pinned revisions, SHA-256 digests and publication dates before November 10. Credit **Ironflow (ironflow.sh)** under CC BY 4.0. Its hourly open interest becomes available at hour close. The perpetual instruments in this sample are USDT-denominated and USDC-settled. [Publisher's catalog and file licenses](https://ironflow.sh/datasets) · [Venue contract specifications](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications)

Use Python 3, the LZ4 CLI and DuckDB 1.4.4 for the imports. They read public files anonymously, verify the bytes and install immutable partitions into the same local archive. Repeating an import retains prior sources. Keep the raw cache for independent replay.

```sh
python3 scripts/import-hyperliquid-history.py .runtime-private/desk .runtime-private/qualification-inputs/20250323
python3 scripts/import-depth-preview.py .runtime-private/desk .runtime-private/qualification-inputs/20250323
uv run --with duckdb==1.4.4 python scripts/import-ironflow-history.py .runtime-private/desk .runtime-private/qualification-inputs/ironflow
node scripts/check-historical-desk.mjs .runtime-private/desk
```

| Acceptance | Verified locally |
|---|---|
| Trading VCC-44 and Skills VCC-17 | A browser saved named strategy source by hash and ran the offline scientific subset against archived candles. The desk queued, polled and cancelled jobs and overlaid 40 markers from BTC hypothesis 18. The independent replay reconciled all ten fills and a −2.7923% simulated return after costs, including observed funding rates valued at modeled bar-open prices. |
| Trading VCC-46 | The 20-row run survived restart. A warm run retained its own trace and the original scientific hash. Changed data, parameters and an actual predecessor engine revision each missed the cache. Missing data produced unknown returns and corrupt inputs produced a technical failure. The account revision stayed fixed across research operations. |
| Trading VCC-40 | Open. Live spot and perpetual depth was verified. A complete ticker, trade tape and candle feed still needs a published display grant and end-to-end verification. |
| Trading VCC-45 | Open. The default January 2021–October 2026 run returned 16 partial results and blocked rows 8, 12, 19 and 20. With the BitMEX spot and Binance carry archives installed, the desk evaluates 19 rows with partial coverage. Row 20 requires an executable BTC options history. All 20 individual runs matched the suite on venue, dates, status and return. No hypothesis covered the full requested window. |
| Physical-device verification | Skipped by request. |

The CriptoDB deposit includes BitMEX spot observations for BTC/USDT, ETH/USDT and SOL/USDT. Credit Ángel Hernando-Veciana under CC BY 4.0. The importer retained 11 BTC, 12 ETH and 14 SOL daily bars from May 2025. Each day has complete minute coverage, empty UTC boundary minutes and an identifiable first execution. The desk can run hypotheses 8 and 19 on these native instruments. Open **Historical research** in the desk navigation. When the qualified archives are installed, the form selects `hyperliquid` for perpetuals and `bitmex` for spot hypotheses 8 and 19. Choose a hypothesis and **Queue hypothesis**, or choose **Queue all 20**. **Run history** reopens a previous result from the current browser session. Both spot previews report unknown returns because their 200-day warm-up is missing. [CriptoDB dataset](https://doi.org/10.21950/HFPJ2F)

```sh
python3 scripts/import-criptodb-spot.py .runtime-private/desk .runtime-private/qualification-inputs/criptodb
python3 scripts/import-criptodb-spot.py .runtime-private/desk .runtime-private/qualification-inputs/criptodb --carry
node scripts/check-historical-desk.mjs .runtime-private/desk --native-spot --catalog
```

A completed run opens the selected hypothesis on the existing simulation chart. **View hypothesis on chart** jumps to its archived candles. The chart reads the run’s verified source partitions and shows its instrument, interval, quote currency, date and signal markers. Move the crosshair over a marked candle for execution details. **Return to current market** restores the paper chart. A blocked run displays its missing inputs in the research panel.

The same CriptoDB import supplies 213 hourly BTC/USDT spot bars and 20 hourly linear perpetual bars. Ten UTC hours in May 2025 contain verified observations for both legs. The BitMEX deposit lacks the settled funding and liquidity observations for hypothesis 12. The contract count reconciles to the deposited BTC volume at 0.000001 BTC per contract. [BitMEX contract specifications](https://www.bitmex.com/blog/site-announcement/launch-of-usdt-margined-perpetual-and-futures-contracts-on-10-november-with-zero-fees) · [CriptoDB data and license](https://doi.org/10.21950/HFPJ2F)

For hypothesis 12, choose **Matched spot and perpetual carry** and **Queue hypothesis**. The desk uses the installed Binance carry archive for the individual and suite runs. From May 12–19, 2025 UTC it matches 128 complete BTC/USDT spot hours to perpetual hours, settled funding and both legs’ quote turnover. The paper liquidity screen requires 1% of each leg’s preceding closed-hour turnover to cover the initial capital. The highest annualized funding at a matched close was 10.95%, below the 20% entry threshold. The archive stops before three missing May 20 settlements. [CriptoDB data and license](https://doi.org/10.21950/HFPJ2F)

The native desk reads Bybit ETH/USDT spot and linear perpetual order books collected from Alex Wu’s CostDepth API under CC BY 4.0. Select Bybit and the market type, then open the order book. Each update shows the publisher’s observation time and attribution. The desk marks the book stale after 15 seconds. The read-only binding omits the ticker, OHLCV and trade tape. Paper orders require a qualified mark. [CostDepth API and data license](https://www.costdepth.io/developers#license)

```sh
python3 scripts/collect-public-market.py .runtime-private/desk --admit-costdepth
python3 scripts/collect-public-market.py .runtime-private/desk bybit ETH.USDT spot
python3 scripts/collect-public-market.py .runtime-private/desk bybit ETH.USDT perpetual
node scripts/check-public-depth.mjs .runtime-private/desk/qualification
```

Each collector invocation fetches one observation by default. Add `--samples 2` through `--samples 6` for a bounded session at the publisher’s five-minute sampling cadence. The browser reads the local store. The checker independently compares the published bytes, timestamp, bid/ask sizes, spread, imbalance and cumulative quantities with the desk projections for both markets.

VCC-45 remains open. The published DataForge Aevo sample contains seven UTC days of BTC quotes. Of 6,696 sampled books, 6,327 had a positive bid and ask with size on both sides. None of those books matched contemporaneous Greeks in the required 30–45-day expiry window. The RED-BASIS spot/perpetual archive records indicative funding for the current period. Hypothesis 20 needs four executable legs and a full year of dated IV. [DataForge dataset and ODC-BY grant](https://huggingface.co/datasets/dataforge-labs/crypto-options-surface) · [RED-BASIS deposit and corrections](https://zenodo.org/records/23021004)

A second BTC options deposit contains the first five minutes of 20 monthly dates from January 2021 through August 2022. That leaves gaps in the daily IV history required by hypothesis 20. The deposit identifies Tardis.dev as its source. Its raw quotes were excluded from the desk. Hypothesis 12 uses the documented funding settlement interval when annualizing rates. For the pinned Hyperliquid vintage, the publisher documents hourly settlements during the imported dates. [Options deposit](https://doi.org/10.6084/m9.figshare.34332639.v2) · [Source terms](https://docs.tardis.dev/legal/terms-of-service) · [Funding archive](https://ironflow.sh/datasets)

Prices and costs are research observations and modeled assumptions. The browser checker creates its own owner, database and artifact directory under `.runtime-private/desk/qualification`. Its `verified.json` records actual window, request ID, cache provenance and the row-level outcome. Run `scripts/verify-aggressor-history.py` with the original March session cache, Ironflow cache and the downloaded hypothesis-18 gzip artifact to reproduce the result independently.

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

`runtime/config.mjs` accepts `trading-runtime-config/v1` with `database` (a simple `.sqlite` filename), exact `scope` (`environment: SIMULATE`, `profile: practice|competition`, `account_alias`), a SHA-256 `candidate`, and trusted `keys`. Key records bind `role`, `principal`, `runtime`, an Ed25519 public PEM and optional `revoked`. `viewer_token` is a separate local secret of at least 32 characters, never the broker token. `providers`, when deliberately configured, is an array of reviewed brand-neutral provider definitions (`trading-provider-definition/v1`); each pins one outbound `transport` (`kind: MCP`, an exact https `origin` with no userinfo/query/fragment, a pinned `protocol`), one `mapping` and its `mapping_digest`, adapter/schema digests, `operations`, `allowlist`, `mode: account`, `source: PROVIDER`, a zero-dollar deny-at-exhaustion `cost` and `qualification`. `provider_credentials` maps each provider id to its private `token`, `attestation` and optional `alias_secret`; none is exported. `createProviderRegistry` admits each provider once with isolated adapter/schema/mapping/origin pins, exposes metadata-only discovery, and binds every `PROVIDER` gateway capability to its reviewed definition fail-closed before dispatch; a capability may narrow but never widen the reviewed operations or allowlist.

```sh
npm run runtime -- inspect /absolute/private/config.json
npm run runtime -- serve /absolute/private/config.json 4181
npm run runtime -- configuration /absolute/private/bound-forward.json
npm run runtime -- telemetry /absolute/private/config.json /absolute/private/permit.json /absolute/private/observation.json /absolute/private/bound-forward.json
```

Open **Runtime readback** in the same loopback origin, enter the local viewer token and choose **Read local runtime**. Its authenticated GET exposes a redacted projection only. The token is cleared after each attempted read, including failures, and is never persisted. Base stores the last validated observation independently from execution state; offline use is labelled as stored evidence. Unknown equity, FX or usage stays unknown. Observed-mark drawdown is not an official competition result. Completion, delivery, main-session coverage and child-thread usage remain distinct. Corrupt data, failed reads and competing tab saves do not replace the last accepted observation.

### Export a synthetic ticker for Graph

Run `node scripts/export-ticker-fixture.mjs ./ticker-receipt.json` with a new output filename. The exporter opens an isolated loopback gateway with one synthetic `read.ticker` capability. It checks the HTTP and MCP results against the same request and ledger revision before writing the receipt. The quote has a fixed market time, a capture time, a four-decimal USD price and an unknown feed delay.

Transfer the JSON file to the device running Graph. Under **MainPanel → Integrations → Trading ticker fixture**, choose **Open synthetic receipt**. While online, choose **Install offline workspace**, then **Open verified offline workspace**. Save that revision-specific URL. To replay after closing the tab, reopen the saved URL on the same device and origin and select **MainPanel → Integrations**. The SHA-256 covers the display fields and ledger reference. It checks file integrity. The receipt contains synthetic data and carries no broker identity or execution rights.

### Signed provider ticker for Graph MainPanel

Run one qualified `read.ticker` through the Trading gateway. A UUID v4 request ID travels unchanged. Trading exports a SHA-256 reference for other gateway IDs to keep private labels on the host. Save the exact submitted request in a private file beside the runtime configuration (directory mode 0700, files 0600). The reviewed adapter mapping must project one row with the returned `symbol`, ISO currency and numeric `price` mapped from the provider's decimal string. Optional `market_time_utc` uses UTC ISO seconds or milliseconds. Optional `delay_class` accepts `realtime`, `delayed` or `unknown`. Missing market time and delay remain unknown. The authenticated adapter records whether the source price was a decimal string or a JSON number. A JSON number can be displayed. Signed export requires a decimal string. An older checkpoint with no source-type evidence returns `PRECISION_UNKNOWN` on export. Previously signed receipts retain their original verification and expiry.

The operator-signed read grant needs current account, rights and zero-dollar cost proofs. Its single rights proof must include a `ticker_receipt` object with `audience` set to `graph-mainpanel`, the exact `provider` and `symbol`, `display: true`, `offline_replay: true` and a UTC-seconds `retain_until_utc`. Issue these permissions only under the selected feed's actual display and retention terms.

Run `node scripts/export-provider-ticker.mjs /private/runtime.json /private/request.json ./provider-ticker.json`. Trading verifies the original signed request against the finalized SQLite checkpoint and current configuration, then signs the quote with the configured integration Ed25519 key. Export and cross-frontend retry consume zero additional provider calls. The output retains the provider, candidate, definition, rights and result digests, quote, capture time, delay, request ID, ledger revision and earliest applicable expiry. An existing destination is preserved.

Build Graph with `VITE_TRADING_TICKER_TRUST` set to a JSON object containing the reviewed `provider`, Trading `candidate`, `definition_digest` and `public_key` (the trusted integration public key's Ed25519 JWK `x` value). Provision all four from the operator's configuration independently of the file. Ship only this public binding to Graph. Rotate or withdraw it with a new Graph build and refresh the offline workspace on each device.

In **MainPanel → Integrations → Trading provider ticker**, select **Open signed provider receipt**. Install the offline workspace while connected and open its verified URL for replay. Graph rechecks the signature, binding and expiry when opening the panel, importing, or resuming, and clears an expired quote while displayed. A closed browser can purge its saved copy when the panel next runs. Offline verification uses the installed binding and device clock. A current online revocation decision requires a refreshed installation.


### Authenticated market/account reads

Only the following explicitly invoked command contacts a reviewed provider; do not run it before provider rights, account identity, runtime isolation and a zero-cost deny-at-exhaustion allowance have been independently reviewed.

```sh
npm run runtime -- read /absolute/private/config.json reviewed-run-id /absolute/private/read-grant.json reviewed-provider-id
```

The adapter uses the reviewed definition's pinned MCP origin, initialization/version negotiation and an exact pinned `tools/list` descriptor digest. Four reviewed read tools map into `IN_Quotes`, `IN_Positions`, `IN_Balance` and `IN_Orders`. No tool-name guessing, account fallback, redirect, reconnect or mutation method is provided. `mapping.protocol`, `mapping.account_identity` and each `mapping.sheets` entry must be supplied from reviewed provider evidence. Each entry names `tool`, `parameters`, `rows_path`, explicit `fields` projections and, for account data, `account_path`; optional pagination uses `cursor_parameter`, `limit_parameter` and `next_path`. Decimal fields must arrive as exact strings. Unsupported numeric wire representations or lost precision fail closed.

All envelopes use `{key_id,payload,signature}` with canonical-JSON Ed25519 signatures. Payloads bind schema `trading-runtime-envelope/v1`, kind, principal, runtime, exact scope, candidate, issued/expiry UTC and operation-specific content. A `read` operator grant carries nonce, `mapping_digest`, the four `{sheet,name,schema_digest,effect:read}` bindings, limits (`max_calls` at most 12, timeout at most ten minutes), current cost/rights/account proofs and an explicit zero-dollar budget. The integration signing identity and secret stay outside the browser. Reference fixtures in `test/runtime-ingestion.test.mjs` are generated MOCK evidence, not reusable operational approvals.

Operation-shaped market reads reuse the same reviewed adapter transport and the single durable zero-dollar counter. When `mapping.operations` is supplied from reviewed provider evidence, a `PROVIDER` gateway capability may admit `read.catalog`, `read.candles`, `read.ticker`, `read.depth` and `read.tape` through `createMcpMarketReadAdapter` and `createMarketReadBoundary`; `read.studies` stays local. Each operation binds one read-only tool, an `input_map`/`array_parameters` projection from native inputs, a `rows_path`, explicit `fields` and `numeric` decimal fields, and an `object_result` flag for single-object results. The boundary reserves calls against the identical `runtime-budget/` cost-proof counter as snapshot reads, verifies pinned `tools/list` digests, rejects write-like tool names and fails closed on precision loss. A `read` operator grant for market reads carries `{operation,name,schema_digest,effect:read}` bindings and `max_calls` of at least 3. Reference fixtures in `test/runtime-market-read.test.mjs` are generated MOCK evidence, not reusable operational approvals; connected provider status remains unqualified until independently reviewed rights, account and zero-cost receipts are supplied.

### Simulator account reads

For a qualified moomoo REST binding, add the required entries from `simulatorSpecs` in `runtime/moomoo-simulator-read.mjs` to the reviewed definition and capability. Keep the provider's account-list fields `account_id`, `market_id` and `account_type` in the private REST credential under `simulator_account`. Store its private `alias_secret` alongside it. Account type 1 selects practice and type 2 selects competition.

For the hosted MCP endpoint, select `simulatorMcpSpecs` from the same module and put the simulator account and secret in the private MCP credential. The five native reads cover the selected account, cash, positions, order history and buying power for a new ticket. Use the exact descriptor digests from the admitted host and include `transport: 'MCP'` in `simulatorBindingDigest`. Discovery reserves room for the requested read and its account check. With one catalog page, account selection uses four protocol calls and a financial read uses five. Additional catalog pages consume the same signed allowance. History cursors are private to the transport, account, candidate and window. Use REST for current orders and for buying power against an existing order reference.

A signed read grant must include `read.simulator-account` and the requested operation. Each tool pins its reviewed name and schema, `inputs_digest = sha(parameters)` and `account_binding_digest = simulatorBindingDigest({ provider, scope, account, secret })`. Account discovery, cash, positions and current orders take an empty parameter object. Send the signed parameters alongside the grant. Account discovery returns only the selected alias, profile and account market. Balances and positions each use two GETs under the same allowance, first verifying the account against the provider list. The receipt preserves decimal strings and nullable P&L. Currency stays unknown because these replies omit it. Inspect the receipt through the authenticated loopback HTTP or MCP interface. The public research-file viewer excludes account receipts.

Current orders and order history return the same private reference for a given provider order in this account. Quantities, fills, prices and Unix microseconds retain their source text. The receipt exposes whether an order has a remark. For history, optionally sign `time_begin`, `time_end`, `page_size` and the returned `cursor`. One GET retrieves one page after the account check. The default page size is 50 and the local page limit is 600. A continuation binds the account, candidate, window and page size.

For buying power, sign `symbol`, `order_type` (1 for limit or 3 for market) and the exact `price` for a limit order. The optional `order_ref` requests buying power for an existing ticket. Include `read.simulator-orders` with empty parameters in that grant. The runtime resolves the reference against the current account and symbol, then queries buying power. This uses three GETs. To inspect a completed read, open **Runtime readback → Inspect a completed simulator read** on the local gateway. Select its original signed request file and enter the local gateway token. Lookup reads the matching local checkpoint and makes zero provider calls. Closing the panel clears the display. Run `TRADING_SIMULATOR_BROWSER=1 node --test test/runtime-simulator-read.test.mjs` to verify receipt lookup at phone and desktop widths against the local fixture gateway.

### Independent paper guard and reconciliation

`createPaperGuard({store,scope,candidate,keys,broker,now})` exposes host-only `release({intent,grant,review})`, `reconcile({intent_id,grant})` and `halt({grant,reason})`. The `gateway` command serves these operations against the local labelled MOCK broker; there is intentionally no real broker transport in this implementation: wire-level cutoff enforcement, provider semantics, account qualification and a separately authorized practice canary remain release gates.

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

The approved [trading specification](undocumented-draft/prd-tad-adr-mvp-gtm-agentic-trading.md) and [Skills specification](undocumented-draft/prd-tad-adr-mvp-gtm-agentic-trading-skills.md) own the rollout sequence, runtime qualification criteria, cost controls and recovery gates. Source rollback retains IndexedDB. If a stored schema or evidence binding is incompatible, the journal refuses to overwrite it.
