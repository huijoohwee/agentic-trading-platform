# moomoo read-only snapshot

Run `npm run quote:moomoo -- replay HK.00700 qualification/moomoo/sdk-replay.json` for the synthetic example. The example was round-tripped through the 10.12.7208 SDK protobuf types Qot_GetSecuritySnapshot.Request and Response. Replay works without OpenD, credentials or internet.

For one entitled live read, start Visual OpenD on loopback and sign in there. Use a local Python interpreter with `moomoo-api==10.12.7208`. Select a symbol you are entitled to read for zero incremental cost. Set MOOMOO_PYTHON to that interpreter path and run the following with your actual port and symbol.

```sh
npm run quote:moomoo -- snapshot HK.00700 --entitled-zero-cost --port=11112
```

The command prints one private display quote to stdout. It uses the host’s existing market-data rights and closes the connection. It preserves the provider’s market and code, numeric last price, suspension flag and available UTC timestamp. Currency and delay remain unknown. The snapshot reader supports Hong Kong and US security identifiers. The synthetic test covers a Hong Kong stock. A live result proves the selected symbol and session only. This reader has no order, subscription, redistribution, portfolio or gateway-ledger operation. Roll back by reverting this reader and its gateway dependency pin together.

## Observed live handoffs

On November 23, 2026 the CLI received one HK.00700 snapshot with Hong Kong LV1 access and one US.AAPL snapshot with US LV3 access from Visual OpenD 10.12.7208. Each returned the requested symbol, a positive price, a UTC epoch and a suspension flag. Only these field checks are recorded. The US result had no per-observation Nasdaq Basic attribution or feed-delay guarantee. The two supplied Nasdaq Basic URLs resolved to the same address. The card returned HTTP 439 from the verifier. The US snapshot test used the signed-in local session.

[moomoo API quote rights](https://openapi.moomoo.com/moomoo-api-doc/en/intro/authority.html) · [moomoo Nasdaq Basic card](https://qtcard.moomoo.com/intro/nasdaq-basic?type=16&is_support_buy=1&is_professional=0&navStyle=transparent)
