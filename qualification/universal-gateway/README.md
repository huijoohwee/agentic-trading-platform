# Shared gateway qualification

This local test host runs the same resolver in a browser and Node. Native adapters retain dispatch, authorization and error handling. A successful resolution returns the native response under `native`, including a native refusal. A thrown native error propagates.

Run from the Trading checkout using Node 22.22 or later. Supply clean local checkouts at the revisions in the JSON manifests. Graph needs its installed build tools and Chromium. The workbook fixture is the canonical download from Trading’s rehearsal-workbook export.

```sh
node --test test/runtime-gateway.test.mjs
node qualification/universal-gateway/video.mjs "$GRAPH_CHECKOUT"
node qualification/universal-gateway/workbook.mjs "$SHEETS_CHECKOUT"
```

The quote test sends one fixture read through the resolver, replays it over HTTP and MCP, and checks the same native deadline refusal on all three routes. The desktop video check disconnects the browser before rendering, decodes two samples, and counts dispatches on failed admission. It also exercises a native protocol refusal. The workbook check retains row order, numbers and blanks, examines the native version error and re-encodes the received object.

The resolver SHA-256 before and after adding the workbook connector was `fc8cf04bf4948537e23e9f7177085f594d4e1365b100154e2bbeaa8ec1bcf321`. Graph candidate `4f0d9d98` intermittently encoded a black first sample. Its successor `8e81238f` painted the first raster before opening the capture track. Twelve consecutive desktop renders passed, followed by the manifest-driven check at the corrected pin. All six admission refusals made zero render calls. Physical mobile acceptance is deferred.
