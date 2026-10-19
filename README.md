# @pipeworx/ca-drug-price-transparency

California manufacturer disclosures of prescription drug list-price (WAC)
increases and new-drug launch prices — the reports drug makers are required to
file under California's Cost Transparency Rx (CTRx) law. Read live; keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1843+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ca_rx_wac_increases(drug?, manufacturer?, ndc?, year?, limit?)` — manufacturer
  disclosures of a WAC increase past the statutory threshold. Returns the
  increase amount, the WAC after increase, and the effective date.
- `ca_rx_wac_five_year_history(ndc, year?, limit?)` — the 5-year WAC history a
  manufacturer must disclose alongside each increase report for that NDC.
- `ca_rx_new_drug_launches(drug?, manufacturer?, year?, limit?)` — manufacturer
  disclosures of a NEW drug launched with a WAC above the Medicare Part D
  specialty-drug threshold, with estimated patient population and any
  breakthrough-therapy/priority-review designation.

All three default to searching every available report year (2019–present) when
`year` is omitted, and return a `count` + `years_searched` summary before any
records; a no-match response names the filters tried rather than an empty
array.

## Auth

Keyless.

## Data sources

- California Department of Health Care Access and Information (HCAI), Cost
  Transparency Rx (CTRx) program — manufacturer WAC increase reports, their
  5-year increase histories, and new-drug introduction reports. Published as
  open datasets with one monthly (in-progress current year) and one closed
  annual file per year back to 2019.

## Coverage — why this pack is California-only (fleet #3245 survey, 2026-10-18)

Several states run a manufacturer WAC/launch-price disclosure law similar to
California's. Surveyed before building, because CLAUDE.md's "one pack per
jurisdiction" rule means a second state with genuinely structured public data
gets its own pack, not a `state` argument here — the schemas and even the
reporting thresholds differ per state, and a multiplexed pack cannot describe
either honestly:

| State | Publishes a structured public dataset? | Status |
|---|---|---|
| California | **Yes** — open CKAN datasets, queryable, 2019–present | Built here |
| Minnesota | Yes — two fixed Excel snapshot files (price-growth, new-drug), no history API | Public, keyless, file-only; candidate for a separate local-copy pack, not built in this pass |
| Oregon | No — manufacturers submit through an account-gated portal (iReg); no public query/download tool was found | Not buildable without a credential |
| Colorado | No — Division of Insurance posts narrative PDF reports only | Not structured |
| Vermont | No — Green Mountain Care Board / AG publish narrative PDF reports only | Not structured |
| Nevada | No — DHHS publishes narrative PDF reports (diabetes/insulin-focused) only | Not structured |
| Washington | No — HCA/PDAB publish narrative PDF reports and a claims-based affordability dashboard, not manufacturer disclosure records | Not structured |
| Maine | No — MHDO publishes an annual narrative PDF report only | Not structured |

"Not structured" means no CSV/Excel/API was found publishing the underlying
manufacturer-filed records — only a narrative PDF report summarizing them,
which would require manual transcription rather than ingestion. Re-verify
before assuming this is permanent: states have moved from PDF-only to a real
dataset before (this is exactly what California's own CTRx program did).

## Traps

**Two header shapes per dataset, and they are not cosmetic.** HCAI's
"in-progress current year" resource uses snake_case machine column names
(`manufacturer_name`, `wac_effective_date`, `wac_increase_amount` as a JSON
number). Every CLOSED annual archive (2019 through last full year) uses human
Title-Case column names with spaces ("Manufacturer Name", "WAC Effective
Date") and stringifies the same amounts — the 5-year-history resource further
prefixes them with "$" and commas in BOTH shapes. Matching on one spelling
silently drops every year that doesn't use it; every normalizer here reads
both.

**CKAN's `q` full-text parameter is not a substring filter on the field you
think you're searching.** Measured 2026-10-18: `q=Pfizer` against a 1,251-row
resource with zero rows naming Pfizer anywhere still returned `total: 151` —
it ranks relevance across every text column, including long narrative fields
like "General Comments", and is capped by that ranking rather than by an exact
match. A real hit outside the top-ranked slice could be silently missed. This
pack uses `datastore_search_sql` (also keyless, confirmed live) with an
explicit `ILIKE` on the exact column being searched instead.

**Resource ids are resolved live, not hardcoded.** The "current year" resource
becomes a dated archive every January, the same way CMS's NADAC dataset id
rotates (see `mcps/drug-prices`), and HCAI's own id for it is not guaranteed
stable across that rollover. `resolveResources()` reads CKAN's `package_show`
and classifies every resource by its NAME; a hardcoded last-known-good map
(captured 2026-10-18) is the fallback only if that live lookup itself fails.

**The 5-year-history dataset can contain overlapping entries for the same
NDC.** Each filed WAC Increase Report re-states the preceding 5 years of
history as of its own effective date, so a drug that had two increases in the
same window produces two reports whose history windows overlap. That is a
property of what HCAI publishes, not a dedup bug — `ca_rx_wac_five_year_history`
returns every filed history row rather than silently collapsing them.

**WAC is the manufacturer's published list price, not what anyone actually
pays.** For the retail acquisition cost or the Medicare Part B payment limit,
see `mcps/drug-prices` (`nadac_price` / `asp_payment_limit`) — this pack
answers "what did the manufacturer disclose", not "what does a pharmacy or
Medicare pay".

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ca-drug-price-transparency": {
      "url": "https://gateway.pipeworx.io/ca-drug-price-transparency/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ca-drug-price-transparency/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1843+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ca_rx_wac_increases \
  -H 'Content-Type: application/json' \
  -d '{"manufacturer":"Aadi Bioscience"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ca_rx_wac_increases`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ca-drug-price-transparency": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ca-drug-price-transparency"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ca-drug-price-transparency
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ca Drug Price Transparency data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
