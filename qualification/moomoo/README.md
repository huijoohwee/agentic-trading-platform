# moomoo read-only snapshot

Run `npm run quote:moomoo -- replay HK.00700 qualification/moomoo/sdk-replay.json` for the synthetic example. The example was round-tripped through the 10.12.7208 SDK protobuf types Qot_GetSecuritySnapshot.Request and Response. Replay works without OpenD, credentials or internet.

For one entitled live read, start Visual OpenD on loopback and sign in there. Use a local Python interpreter with `moomoo-api==10.12.7208`. Select a symbol you are entitled to read for zero incremental cost. Set MOOMOO_PYTHON to that interpreter path and run the following with your actual port and symbol.

```sh
npm run quote:moomoo -- snapshot HK.00700 --entitled-zero-cost --port=11112
```

The command prints one private display quote to stdout. It uses the host’s existing market-data rights and closes the connection. It preserves the provider’s market and code, numeric last price, suspension flag and available UTC timestamp. Currency and delay remain unknown. The snapshot reader supports Hong Kong and US security identifiers. The synthetic test covers a Hong Kong stock. A live result proves the selected symbol and session only. This reader has no order, subscription, redistribution, portfolio or gateway-ledger operation. Roll back by reverting this reader and its gateway dependency pin together.

## Observed live handoffs

On November 23, 2026 the CLI received one HK.00700 snapshot with Hong Kong LV1 access and one US.AAPL snapshot with US LV3 access from Visual OpenD 10.12.7208. Each returned the requested symbol, a positive price, a UTC epoch and a suspension flag. Only these field checks are recorded. The US result had no per-observation Nasdaq Basic attribution or feed-delay guarantee. The two supplied Nasdaq Basic URLs resolved to the same address. Chromium opened the card with HTTP 200 and displayed “Nasdaq Basic+TotalView”. A plain HTTP client received 439. The US snapshot test used the signed-in local session.

[moomoo API quote rights](https://openapi.moomoo.com/moomoo-api-doc/en/intro/authority.html) · [moomoo Nasdaq Basic card](https://qtcard.moomoo.com/intro/nasdaq-basic?type=16&is_support_buy=1&is_professional=0&navStyle=transparent)

## Offline compatibility and quote sides

Run `npm run quote:moomoo -- discover` to see both pinned provider profiles, supported inputs and outputs, losses and requirements. The CLI can replay a local response immediately. Live discovery lists the qualified SDK, authenticated local session and symbol entitlement as prerequisites. Checking those externally supplied facts or invoking OpenD requires a separate explicit operation.

Each snapshot includes `bid` and `ask` as independent price strings. An omitted side or a provider zero yields JSON null for that side. Malformed prices fail the read. These values have the same double precision limit as the last price. One entitled HK.00700 read returned both sides on November 23, 2026. The test recorded presence and a valid UTC time. Depth, delay class and per-quote feed attribution remain unverified.

## Desktop MCP capture (desktop-mcp)

`desktop-mcp-capture.json` records four real entitled $0 reads for HK.00700 captured through the available Qoder Desktop `mcp://moomoo` binding (OpenD-backed) at 2026-11-23T23:17:44Z (HK market date 2026-11-23): `quote_stock_quote` (last 344), `quote_order_book` (10 bid/ask levels, SEHK), `quote_rt_ticker` (20 ticks) and `quote_cur_kline` (5 daily candles). It pins each tool's captured descriptor (`name`, `description`, `inputSchema`) and the raw `structuredContent` responses.

This is **Desktop-binding evidence, distinct from the hosted `https://mcp.moomoo.com/mcp` OAuth milestone (N3)**, which is qualified separately by the hosted capture surface (`hosted-mcp-capture.json`). The hosted host may advertise additional descriptor fields and required separate candidate-bound qualification; no hosted receipt is claimed by this Desktop fixture.

Trading owns the reviewed mapping (`src/provider-capture.mjs`) that binds `read.ticker`, `read.depth`, `read.tape` and `read.candles` to those four read-only tools. `runtime/mcp-market-read.mjs` projects each response, recording the exact round-trip decimal string for every numeric field (the MCP returns JSON numbers, not decimal strings). `test/runtime-moomoo-capture.test.mjs` proves the projection, the shared $0 counter, schema/mapping/write/precision refusals, and that one provider read replays identically across the inbound HTTP (`/api/gateway`) and MCP (`/mcp`) interfaces with the same request id, result digest and ledger revision and zero extra provider calls. The dashboard disclosure (`src/capture-view.mjs`) renders a curated summary pinned to the captured projection; currency, delay class and per-quote feed attribution stay labelled unknown, while hosted N3 is resolved by the hosted capture surface. Tick `sequence` values exceed 2^53 and are left opaque (not projected) because JSON number encoding cannot preserve them.

## Moomoo-inspired market desk (read-only $0 replay)

The dashboard disclosure `#provider-desk` (`src/moomoo-desk-view.mjs`) composes a moomoo-style trading desk from the pinned Agentic Design System / Base owner primitives — `DashboardCardGrid` quote board (last, change vs prev close, day range, volume, turnover) — plus owned SVG diagrams (`src/desk-diagrams.mjs`): a mirrored order-book depth ladder (10 ask / 10 bid, SEHK, bar length is volume), a time & sales volume column diagram (20 ticks, color is direction) and a daily candlestick chart (5 sessions, open/high/low/close). An owner `mountDashboardChart` column chart shows daily volume, and `mountDataView` tables remain as drill-down for the ladder, tape and candles. Diagrams consume scoped `--desk-up` / `--desk-down` semantic colors (Design System success plus the journal's existing down red); no Design System token is forked, overridden or duplicated. Rows come from `src/provider-desk.mjs`, which adapts the saved MCP responses to the pinned Gateway QUOTE, ORDER_BOOK, TICKER and KLINE replay functions during the static build. The browser loads only projected chart rows when the desk opens. These local frame envelopes preserve Desktop capture provenance, keep each price’s round-trip decimal string and omit unsafe numeric trade sequences; `test/provider-desk.test.mjs` pins every row and `test/desk-diagrams.test.mjs` pins the diagram geometry against `desktop-mcp-capture.json`. The desk is lazy-loaded on first open, makes zero provider calls, and exposes no order, subscription or live-feed control. Currency, delay class and per-quote feed attribution remain unknown.

Open **Inspect a saved quote push** to preview one local JSON frame under 500 kB. Supply its expected symbol, or the expected market for MARKET_STATE. The independently labelled preview uses the pinned Gateway connector for six documented types. It shows up to 40 source rows per list, preserves broker IDs and tied ranks, and displays an unknown market state with its numeric code. Clearing the file removes the preview. The tab keeps no saved copy. The Desktop chart rows retain their original capture provenance. [Quote push format](https://open.moomoo.com/api/quote/push/data-format)

## Route inventory and offline research reads

Open **Moomoo OpenAPI coverage** on a primed dashboard to search the pinned Gateway directory and mirror by tool name, HTTP path or push topic. The build includes digests for 107 publicly advertised tools and records separate source hashes for the 196 mirrored pages and 109 supplemental public references. The Desktop capture and hosted ticker each carry their own provenance.

The reviewed definitions in `runtime/moomoo-research.mjs` map `read.capital-flow` to a single symbol and session, and `read.rank` to one hot-list page. Capital flow preserves signed amounts in native currency and Unix milliseconds. A ranking result includes the provider's completion flag, next cursor and total. Each subsequent page needs a new admitted request. Run `node --test test/runtime-rest-market-read.test.mjs test/provider-ticker-receipt.test.mjs` for signed local examples. A host that binds both transports for one provider supplies separate private `provider_credentials[provider].transports.MCP` and `.REST` entries. The dashboard renders saved evidence offline.

The route inventory identifies 30 REST mappings, including 26 GETs with parameter-bound signed fixtures and the market-wide stock-screen POST. The dashboard lists the reviewed projection and units for each mapped route. Other endpoints in the same family keep their own status.

| Research read | Fields covered by the fixture |
| --- | --- |
| Sector directory, HK IPOs | Market and sector IDs, listing dates, prices and lot size. Undisclosed IPO dates and prices are null. |
| News search, analyst ratings | Headline, source, publication epoch and opaque ID. Analyst pages retain provider target-price text, market date and continuation. |
| Financial statements | A signed statement type selects income, balance sheet, cash flow or key metrics. The report preserves currency, accounting standard, fiscal period and the provider’s value type for each line item. An opaque `next_key` continues the same query under a fresh grant. |
| Company profile, dividends, shareholders, influencer holdings | Localized profile fields, dividend statement and dates, reported holder weights, and estimated positions. |
| Macro, ETF, event contracts, crypto | Indicator directory by region, ETF weights and disclosure time, event directory by series, and aggregate USD market cap and turnover. |
| Futures | Read CFTC contract counts and weekly changes, seasonal series with an optional year or price, and correlations for up to four signed related symbols. Page size on correlation reads applies to each series. The published samples contain placeholders. Local fixtures exercise the documented field types. |
| Options | Chains bind the underlying and expiry window. Expiry reads preserve signed days and cycles. Option trade events preserve source price strings, Unix microseconds, nullable Greeks and IV in percent. |
| Derivatives activity, valuation, HK short interest | Provider movement summary, historical PE/PB/PS ratios, and HK short shares and float percentages. |
| Stock Connect, top brokers, chip distribution, CBBC | Daily flow in yuan and shares, both sides of HK broker rankings, chip prices and profit ratio, and outstanding bull/bear quantities with the supplied currency. |

For these twenty-six reads, the operator signs an `inputs_digest` on the grant’s tool entry. Compute it with `sha(parameters)` from `runtime/core.mjs`, using the exact request parameters including any cursor and excluding the grant envelope. Trading checks it before the provider GET. A fresh page or symbol requires its corresponding authorization. The existing calendar, capital-flow and ranking contracts continue to accept their reviewed grants. The signed fixtures use a local response transport. Connected research requires private REST credentials, current rights and call headroom for the named operation.

## Simulator route coverage

Search for `/sim-trade/` in the route inventory. Six GETs cover account discovery, cash, positions, buying power, current orders and order history. Three POSTs describe placing, modifying and cancelling a simulator ticket. Each route lists its required fields or units. Connected simulation requires the named account, a signed simulator grant and independent approval for each ticket effect. The local paper broker signs its observations as MOCK. It refuses a provider source label and refuses to reuse retained balances or fills with a conflicting origin. The original ledger remains available for reconciliation.

Opening an advertised tool in the route finder loads its public HTTP field register from the sealed site. The field list shows path variables, declared parameters, body fields, limits and top-level response names. Required and optional labels reflect explicit values in the published schema. Connected MCP admission still checks the host’s own descriptor.

The route finder combines 196 original mirror sources and 109 separately hashed public Markdown files. It lists 258 distinct REST routes, 107 public tool names and 24 push topics. Thirty REST reads have local mappings. Five MCP tools have mappings, including the stock-screen fixture. The connected captures retain their own host, operation and grant.


## Stock screening over REST and MCP

Use `read.stock-screen` with the REST definition from `researchMapping` or the separate `stockScreenMcpMapping` in `runtime/moomoo-research.mjs`. Both use the pinned Gateway connector. A screen takes one market and optional factor filters, retrieval columns, sorts, limit and cursor. For example, `{"market":"HK","factors":["last_price","pe_ttm"],"filters":[{"factor":"pe_ttm","upper":{"value":"15.25","includes":true}}],"limit":20}` returns a bounded market-wide page. Each factor includes its raw integer and exact scaled decimal text. Sorts, column order and the opaque cursor are part of the signed input digest. A terminal page has a null next cursor.

The REST adapter builds a JSON POST only for the exact stock-screen route on the published origin. MCP discovers the host’s descriptor and calls the named tool. Both enforce the operator’s grant and local call reservation. Local fixtures verify dispatch and refusal. The four Desktop market captures and the hosted ticker retain their original evidence. Watchlists, holdings and advanced screen conditions require separate mappings. [Stock screen](https://open.moomoo.com/api/quote/screening/stock-screen)
