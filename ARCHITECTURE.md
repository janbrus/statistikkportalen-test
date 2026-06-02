# Architecture

Statistikkportalen is a single-page application built with vanilla JavaScript — an alternative interface for browsing and downloading statistics from SSB (Statistics Norway). No build step, no bundler, no package manager. All modules are loaded via `<script>` tags in `index.html` and communicate through global objects on `window`.

The app fetches the full table catalogue (~7 000 tables) from SSB's PxWebApi v2, lets users search, browse by topic, select variables, and view/export data — all in the browser with aggressive local caching.

## Load order and dependencies

Scripts are loaded in this exact order (each depends on those above it):

```
version.js          — VERSION constant (displayed in footer)
config.js           — AppConfig, logger
translations.js     — t(), tpl(), setLanguage(), getCurrentApiLang(); translation dictionary for all UI strings
cache.js            — CacheManager (IndexedDBCache + localStorage hybrid)
api.js              — SSBApi (uses CacheManager, AppConfig)
utils.js            — AppState, renderCurrentView(), helpers, addEscapeHandler()
router.js           — URLRouter, SSBURLMapper (uses AppState, BrowserState, render*)
subjects.js         — SubjectConfig: subjectGroups + subjectNames (instance-specific, swapped per data source)
menu-hierarchy.js   — MenuHierarchy class (uses SubjectConfig)
browser-state.js    — BrowserState (uses api, MenuHierarchy, SearchEnhanced, AppState)
menu-bar.js         — Filter bar rendering (uses BrowserState)
front-page.js       — renderFrontPage (uses BrowserState, URLRouter)
synonyms.js         — SearchSynonyms: synonym groups for enhanced search (instance-specific)
search-enhanced.js  — SearchEnhanced (uses SearchSynonyms; pure scoring/ranking, no side effects)
search-view.js      — renderSearchView (uses BrowserState, SearchEnhanced, api)
topic-view.js       — renderTopicView (uses BrowserState, URLRouter)
variable-select-state.js     ─┐
variable-select-status.js     │
variable-select-codelists.js  │  All share module-level variables
variable-select-render.js     │  (tableMetadata, activeCodelists, etc.)
variable-select-events.js     │  defined in state.js
variable-select-api.js        │
variable-select.js           ─┘  Main entry: renderVariableSelection()
table-display.js    — renderTableDisplay, displayData, buildHtmlTable (uses api, AppState)
table-metadata.js   — buildMetadataSection (uses currentFullMetadata from table-display)
table-save-query.js — showSaveQueryDialog (uses currentData, AppState, api)
table-rotation.js   — openRotationDialog (uses AppState, re-calls displayData)
export.js           — showExportDialog, quickExportXlsx (uses api, AppState)
vendor/chart.umd.min.js  — Chart.js v4 UMD (exposes global Chart)
chart-view.js       — renderChart, destroyChart, buildChartData (uses Chart, AppState, table-display helpers)
```

## Global state objects

There are three primary state holders. Understanding what lives where is critical:

### `AppState` (utils.js)

Current session state for the active view. Resets when the user navigates away from a table.

```
currentView         — 'home' | 'search' | 'topic' | 'variables' | 'table'
selectedTable       — { id, label } or null
variableSelection   — { DimCode: ["val1","val2"] | "*" | "top(N)", ... }
activeCodelistIds   — { DimCode: "codelistId", ... }
tableData           — Raw JSON-Stat2 response (set after fetch)
tableLayout         — { rows: ["Tid"], columns: ["Kjonn","Region"] }
topicPath           — ["be","be02"] (current topic navigation)
navigationRef       — "topic/be/be02?disc=0" (for "back" button and breadcrumbs)
```

### `BrowserState` (browser-state.js)

Long-lived browsing state. Initialized once (lazy, on first use) and persists across views.

```
menuHierarchy       — MenuHierarchy instance (tree of subjects → topics → tables)
allTables           — Full array of ~7000+ table objects from API
recentTables        — Tables updated in the last 7 days (from pastDays=7 API call, used by front page)
isLoaded            — Whether init() has completed
searchFilters       — { query, includeDiscontinued, subjectFilter, frequencyFilter, updatedFilter, enhanced }
topicFilters        — { includeDiscontinued, frequencyFilter, updatedFilter }
_searchIndex        — Lazily built normalized index for enhanced search
```

### Module-level variables in variable-select-state.js

Shared across all six `variable-select-*.js` files via closure over global scope:

```
tableMetadata       — Full JSON-Stat2 metadata for current table
activeCodelists     — { DimCode: { codelistId, values, elimination, ... } }
dimensionValueOrder — { DimCode: ["code1","code2",...] } (ordering from first codelist)
lastClickedIndex    — { DimCode: N } (for shift-click range selection)
```

### Module-level variables in table-display.js

Shared across the five table display files (`table-display.js`, `table-metadata.js`, `table-save-query.js`, `table-rotation.js`, `chart-view.js`):

```
currentData         — Raw JSON-Stat2 data response (the flat value array and dimensions)
currentFullMetadata — Full metadata for the current table (source, notes, contacts, etc.)
viewMode            — 'table' | 'chart' (selected via the 📈 toggle; reset to 'table' on
                       navigation away or after destroyChart() in chart-view.js)
```

## What happens when...

### The user opens the app

```
DOMContentLoaded
  → api.cleanupCache()           // Remove expired localStorage/IndexedDB entries
  → URLRouter.handleRoute()      // Parse hash, dispatch to view
     or renderCurrentView()      // Default: home
```

### The front page loads

```
renderFrontPage()
  → BrowserState.init()                        // Lazy: awaits getConfig first (server limits
                                               // → AppConfig.limits.maxCells), then fetches
                                               // these two in parallel:
     1. Full table list (~7000 tables)          //   for subject grid and search
     2. api.getTables({ pastDays: 7 })          //   recently updated tables (small response)
                                               //   .catch → null on failure (front page falls
                                               //   back to walking the full hierarchy)
  → _collectRecentUpdateGroups(mh, recentTables)
     → Uses pre-fetched recentTables when available (avoids scanning all 7000 tables)
     → Groups by topic node path from each table's paths[] field
     → Buckets: "I dag", "I går"/"Forrige virkedag", "Siste 7 dager"
     → Falls back to walking the full hierarchy tree if pastDays call failed
  → Render: search input, 6-column subject grid, recently updated tables
```

### The user searches for "arbeidsledighet"

```
renderSearchView()
  → BrowserState.init()                    // Lazy: fetch all ~7000 tables, build MenuHierarchy
  → _handleSearchInput()                   // Debounced (500ms)
     → BrowserState.filterTables()         // Client-side: filter allTables by query + filters
        → If enhanced: SearchEnhanced.buildIndex() (once), then filterAndRank()
           → _expandTokens() adds synonyms: "arbeidsledighet" → also tries "ledige", etc.
           → _scoreEntry() ranks: title match (30) > ID (15) > variable (10) > path (8)
        → If standard: simple substring match on label, id, variableNames
     → _renderSearchResults()              // Show client results immediately
     → If enhanced or 0 results:
        → api.getTables({ query })         // Server-side search (searches VALUES not in local list)
        → Merge server extras with client results, re-render
        → If still 0: buildFuzzyQuery() → retry with ~1 (Lucene edit-distance)
```

### The user selects a table (e.g. table 09772)

```
BrowserState.selectTable("09772")
  → Captures navigationRef ("topic/be/be02" or "search?q=...")
  → sessionStorage.setItem('ssb_navRef', ...)    // Survives page refresh
  → AppState.setSelectedTable(table)
  → AppState.setView('variables')
     → renderVariableSelection()
        → buildNavigationBreadcrumb()             // Show topic path leading to this table
        → api.getTableMetadata("09772")           // Cached 7 days
        → displayVariables()
           → Look up roleByDim from tableMetadata.role (time/geo/metric)
           → For each dimension in metadata:
              → renderDimensionCard()              // Title, role badge (Tid/Geografi/Statistikkvariabel),
                                                   // elimination badge, selection mode buttons, value list
                                                   // Time dimensions get a format hint as the filter placeholder
                                                   // (sampled from the latest period code, e.g. "Format: 2024M06")
              → setupCodelistDropdowns()           // If dimension has extension.codelists[]
              → restoreSelections()                // From AppState.variableSelection (URL state)
           → Read localStorage.varSelectLayout — if 'compact', add .compact to
             #variables-container so dimension cards render in an auto-fit grid
             (1/2/3 columns on wide screens). Toggle button in view-header
             reflects state via .btn-active + aria-pressed.
           → Wire events: click, shift-click, Ctrl+click, Ctrl+A, filter input, mode buttons
              // Mode buttons per dimension card:
              //   "Velg alle"   → star mode ("*"): API wildcard, all values including future ones
              //   "Opphev alle" → deselect all (specific mode, empty selection)
              //   "Siste N"     → top(N) mode (time dimensions only)
           → updateAllStatus()                     // Validate, show cell count, enable/disable "Hent data"
```

### The user opens the API builder

The API builder panel is rendered inside the variable selection view by `variable-select-api.js`. It generates a live preview of the GET and POST URLs for the current selection, and is updated on every selection change.

```
setupApiBuilder()
  → updateApiPreview()           // Called on every selection change
     → buildGetUrl()             // Constructs GET URL with valueCodes[Dim]=... params
        → Time dimension optimisation:
           1 period   → top(1)
           2 periods  → top(2)
           >2 periods → from(firstPeriod)   // forward-looking: always fetches from fixed start
        → codelist[Dim]=id appended whenever a codelist is active
        → outputValues[Dim]=aggregated appended for agg_* codelists
        → URL shown decoded (plaintext) by default
     → buildPostBody()           // Constructs JSON POST body for display
  → Format selector: JSON-stat2 | CSV | Excel | PX | HTML
     → On render, options not present in AppConfig.limits.dataFormats
       (populated from /config) are removed; the export dialog filters
       its radio group the same way
  → "Kopier URL" button  → copies GET URL to clipboard
  → "Kopier POST-body" button → copies JSON POST body to clipboard
```

### The user clicks "Hent data"

```
handleFetchData()
  → getVariableSelection()                 // Read DOM state → { Dim: [codes] | "*" | "top(N)" }
     // Codelist handling in getVariableSelection():
     //   vs_ (filter) codelist active  → expand via valueMap (no-op: valueMap[0] === code)
     //   agg_ (aggregation) codelist active → keep aggregate codes as-is;
     //                                         API resolves them via codelist ID in POST body
  → AppState.variableSelection = selection
  → AppState.setView('table')
     → renderTableDisplay()
        → buildNavigationBreadcrumb()      // Show topic path as breadcrumb
        → api.getTableData("09772", selection, "no", codelistIds)   // POST, never cached
        → determineDefaultLayout(data)     // See "Default table layout" below
        → displayData()
           → buildMetadataSection()        // table-metadata.js: collapsible panel (source, contact, notes,
                                          // "Om statistikken"-link built from paths[*][2].id kortnavn,
                                          // and Klass/VarDok links from link.describedby URNs)
           → buildHtmlTable()
              → buildDimensionCombinations(rowDims)    // Cartesian product of row values
              → buildDimensionCombinations(colDims)    // Cartesian product of column values
              → For each row × column:
                 → getDataValue() → calculateFlatIndex() → data.value[i]
                 → getDataStatus() → check data.status for suppressed values (".", ":", "..")
           → Wire: rotate button, export buttons, save query button
```

### The user rotates the table

```
openRotationDialog()                       // table-rotation.js
  → Drag-and-drop UI: move dimension chips between "Rader" and "Kolonner"
  → Preset buttons for common layouts (e.g. time as rows)
  → On apply:
     → AppState.tableLayout = { rows: [...], columns: [...] }
     → AppState._updateHash('table')       // Encode new layout into URL
     → displayData()                       // Re-render table with new layout
  → Escape key closes dialog (via addEscapeHandler)
```

### The user toggles the chart view (📈)

The chart toggle button is rendered by `displayData()` in `table-display.js` whenever `currentData.role?.time?.[0]` is set. Clicking it flips the module-level `viewMode` and calls `displayData()` again — which then dispatches to either `buildHtmlTable()` or the chart renderer.

```
#chart-toggle-btn click
  → viewMode = (viewMode === 'chart') ? 'table' : 'chart'
  → displayData()                          // table-display.js, full re-render
     → destroyChart()                      // safe no-op if no chart active
     → if (viewMode === 'chart' && hasTimeDim):
        → renderChart(canvas, currentData, AppState.tableLayout)   // chart-view.js
           → buildChartData(data, _layout)
              // _layout ignored — chart always puts time on x-axis
              → timeDim = data.role.time[0]
              → x-labels = data.dimension[timeDim].category.label,
                            sorted by category.index value (NOT alphabetical)
              → nonTimeDims × combos → one dataset per combination
              → seriesLabel = combo.codes.map(category.label).join(' · ')
                  // single-line fallback: cleaned extension.px.contents
              → For each combo, look up per-series decimals:
                  data.dimension[metricDim].category.unit[metricCode].decimals
                  // agg_ codelist on metric → fallback to extension.px.decimals
              → For each time period:
                  flatIdx = calculateFlatIndex(fullIndices, data.size)
                  data.status[String(flatIdx)] != null → null (gap, not 0)
                  spanGaps: false on the dataset → hulls render as hulls
           → Chart.js v4 line config (SSB-dataviz-skill conventions):
              palette ranks 1–8 (#1A9D49 first), grey beyond
              plugins.title:     extension.px.contents (top)
              plugins.subtitle:  "Kilde: {AppConfig.source.name}, tabell {id}.
                                  Sist oppdatert: {YYYY-MM-DD}"  (bottom)
                                 // i18n via chart.source / chart.tableWord / chart.lastUpdated
              plugins.tooltip:   formatNumber(value, ctx.dataset.decimals ?? 0)
              scales.y.ticks:    formatNumber(v, Math.max(...d.decimals))
        → If lineCount > MAX_RECOMMENDED_LINES (12), show .chart-warning above canvas
     → else: buildHtmlTable()
```

`destroyChart()` MUST run before the canvas is removed from the DOM, otherwise Chart.js logs "Canvas is already in use" on the next render. All paths that tear down the table view call it: the toggle handler (re-entry), the back-to-browser handler, the back-to-variables handler, and the chart-mode rotation apply (which re-runs `displayData()`).

### The user saves/shares a query

```
showSaveQueryDialog()                      // table-save-query.js
  → Fingerprint current selection (tableId + variables + codelists + layout)
  → If same fingerprint as last save → reuse cached query ID
  → Otherwise: POST to /savedqueries with selection + placement
  → Display dialog with two shareable links:
     → SSB link: https://data.ssb.no/api/pxwebapi/v2/savedqueries/{id}
     → Statistikkportalen link: #sq/{id}
  → Escape key closes dialog (via addEscapeHandler)
```

### The user exports data

```
quickExportXlsx()                          // One-click Excel download
  → api.downloadTableData(tableId, selection, { format: 'xlsx', stub, heading })
     → POST to /tables/{id}/data?outputFormat=xlsx
     → Response as blob → create <a download> → trigger click → cleanup

showExportDialog()                         // Full options dialog
  → User picks format, display format, separator, layout
  → executeExport()                        // Same API call with chosen options
  → Escape key closes dialog (via addEscapeHandler)
```

## Caching architecture

```
CacheManager (cache.js)
├── localStorage     — Items < 1MB (fast, synchronous read)
│   └── Key format: ssb_{cacheKey}
│       Value: JSON { value, expires, stored }
│
├── IndexedDB        — Items ≥ 1MB (table list is ~2-4MB)
│   └── Database: ssb_cache, Store: cache
│       + localStorage ref: ssb_{key}_ref → { storage: 'indexeddb', size }
│
└── Staleness check  — _isStaleBySSBSchedule(storedTimestamp)
    └── Compares stored timestamp against last SSB update
        SSB updates at 05:00, 08:00, 11:30 Norwegian time daily
        If stored before last update → stale → evict
```

What gets cached:

- **API config** (`api_config`): 24h TTL, ~1KB → localStorage
- **Table list** (`tables|no|true|10000|||`): 24h TTL, ~2-4MB → IndexedDB
- **Recent tables** (`tables|no|true|10000|||7`): 24h TTL, small → localStorage
- **Table metadata** (`table_{id}_no`): 7 day TTL, ~5-50KB → localStorage
- **Codelists** (`codelist_{id}_no`): 7 day TTL, ~1-20KB → localStorage
- **Query results**: Never cached (each user query is unique)
- **Server search results** (`tables|no|true|10000||{encoded-query}|`): 24h TTL

The table-list key shape is centralised in `api._buildTableListCacheKey(...)`.
Fields are pipe-separated in fixed order — `lang | includeDiscontinued |
pageSize | pageNumber | encodeURIComponent(query) | pastDays` — so a literal
`|` in user input can't collide with adjacent fields, and `getAllTables` and
`getTables(pageNumber=1)` share the same key for the full-list case.

## URL state encoding

All view state is encoded into the URL hash so any view can be bookmarked and shared.

```
#home
#search?q=bnp&disc=0&subj=nk&freq=Quarterly&upd=30&enh=1
#topic/be/be02?disc=0&freq=Monthly
#variables/09772?v={base64}&c={base64}
#table/09772?v={base64}&c={base64}&l={base64}
#sq/30116027
```

The `v`, `c`, and `l` parameters are JSON objects encoded as URL-safe Base64:

- Standard Base64, then `+`→`-`, `/`→`_`, `=`→`~`
- `v` = variableSelection: `{ "Kjonn": ["1","2"], "Tid": "top(5)" }`
- `c` = activeCodelistIds: `{ "Region": "vs_RegionKommune" }`
- `l` = tableLayout: `{ "rows": ["Tid"], "columns": ["Kjonn","Region"] }`

## SSB API integration

All API calls go through `SSBApi` (api.js) which enforces 100ms minimum spacing between requests (SSB rate limit: 30/min). The API follows the [PxWebApi v2 spec](https://github.com/PxTools/PxApiSpecs/blob/master/PxAPI-2.yml).

```
GET  /config                          — API limits and capabilities (cached 24h)
GET  /tables?lang=no&pageSize=10000&includeDiscontinued=true[&query=...][&pastDays=7]
GET  /tables/{id}/metadata?lang=no
GET  /tables/{id}/data?lang=no&valueCodes[Dim]=codes[&codelist[Dim]=id][&outputFormat=...]
POST /tables/{id}/data?lang=no[&outputFormat=xlsx&outputFormatParams=...]
GET  /codeLists/{id}?lang=no
POST /savedqueries                    — Create saved query
GET  /savedqueries/{id}               — Fetch saved query
```

### Dynamic configuration

On startup, `api.getConfig()` fetches the `/config` endpoint and updates `AppConfig.limits.maxCells` with the server's `maxDataCells` value. This means the cell limit in the variable selection view adapts automatically if SSB changes their limits. The warning threshold is set to 75% of the max. If the `/config` call fails, the hardcoded defaults in `config.js` are used.

### Error handling

All API methods use `_handleErrorResponse()` which parses RFC 7807 Problem Detail responses. SSB returns structured JSON errors with a `detail` field containing specific messages (e.g. "Value, xxx is not a valid value code for variable yyy"). Status codes handled:

- **400** — Bad request (invalid value codes, malformed query). Shows the `detail` message.
- **403** — Forbidden (query exceeds cell limit). Shows `t('error.cellLimit')` (falls back to API `detail` if present).
- **404** — Not found (table/codelist doesn't exist). Shows the `detail` message.
- **429** — Rate limited. Shows `t('error.rateLimit')`.

### POST body for data requests

```json
{
  "selection": [
    { "variableCode": "Kjonn", "valueCodes": ["1","2"], "codelist": "vs_Kjonn" },
    { "variableCode": "Alder", "valueCodes": ["005","1014"], "codelist": "agg_FemAarigGruppering", "outputValues": "aggregated" },
    { "variableCode": "Tid", "valueCodes": ["top(5)"] }
  ],
  "placement": {
    "heading": ["Kjonn"],
    "stub": ["Tid"]
  }
}
```

Dimensions omitted from `selection` are "eliminated" — the API aggregates across all values. Only dimensions with `extension.elimination=true` in metadata can be omitted.

**Codelist types and how they affect `valueCodes`:**

- **`vs_` (valueset/filter):** `valueCodes` contains original dimension codes. The codelist restricts which codes are valid; `valueMap` is a no-op (`valueMap[0] === code`).
- **`agg_` (aggregation):** `valueCodes` contains the codelist's own aggregate codes (e.g. `"005"` for "0–4 år"). The API uses the `codelist` field to resolve these to underlying values and return grouped totals. Sending expanded original codes here would be wrong. `buildPostBody()` also adds `"outputValues": "aggregated"` for any `agg_*` codelist so the API returns the summed values rather than the underlying single values (critical for e.g. `agg_KommSummer` time-consistent municipality totals); the GET-URL preview emits the matching `outputValues[Dim]=aggregated` query parameter.

## JSON-Stat2 response format

The API returns data in JSON-Stat2 format. Key structure:

```json
{
  "id": ["Region", "Kjonn", "Tid"],
  "size": [3, 2, 5],
  "dimension": {
    "Region": {
      "label": "region",
      "category": {
        "index": { "0301": 0, "1103": 1, "4601": 2 },
        "label": { "0301": "Oslo", "1103": "Stavanger", "4601": "Bergen" }
      }
    }
  },
  "value": [1234, 5678, ...],
  "status": { "7": ".", "15": ":" }
}
```

Values are stored in a flat array. To look up a specific cell:

```
flatIndex = Region_index × (size_Kjonn × size_Tid)
          + Kjonn_index × size_Tid
          + Tid_index
```

This is implemented in `calculateFlatIndex()` (table-display.js).

The optional `status` field maps flat indices (as strings) to suppression codes (per SSB convention):
- `"."` — not applicable (ikke mulig å oppgi tall)
- `".."` — not available (tallgrunnlag mangler)
- `":"` — confidential (konfidensielt)

When a status code is present for a cell, the UI shows the symbol instead of a number and adds a tooltip with the Norwegian explanation. The chart view (`chart-view.js`) maps the same status-coded cells to `null` so Chart.js draws gaps (`spanGaps: false`) — statistical integrity over visual smoothness.

`chart-view.js` also reads `dimension[role.metric[0]].category.unit[metricCode].decimals` for per-series precision (Personer1 → 0, KpiIndMnd → 1, valutakurser → 4), instead of hardcoding a decimal count. Same field, different consumer than the data table's per-column formatting.

## Default table layout

`determineDefaultLayout(data)` in `table-display.js` picks the initial `rows`/`columns` split for a fresh table render. The rotation dialog's "Standard" preset delegates to the same function — single source of truth.

Two modes, switched on the product of selected non-time dimension sizes:

- **Compact mode** (`product < 16`) — every non-time dimension goes to columns, Statistikkvariabel (`role.metric[0]`) on top, the rest narrowest-first underneath. The time dimension is the only row. Each metric × breakdown combination gets its own column.
- **Standard mode** (`product ≥ 16`) — Statistikkvariabel and the narrowest non-time dimension go to columns; time + any wider non-time dimensions go to rows. Keeps the column count tractable on wide tables.

In both modes Statistikkvariabel is the first column entry, so it renders as the topmost `<th>` row (the column-header stack iterates `columns` top-down in `buildHtmlTable`).

Fallbacks: when `role.metric` is absent the narrowest non-time dim takes the top slot; when `role.time` is absent everything ends up in columns and a degenerate-demote pops the narrowest col into rows so the table still has a vertical axis. Single-dim and zero-dim tables short-circuit early.

The "selected count" for each dimension is `data.size[i]` from the JSON-Stat2 response — the actual returned count, whether the user picked `*`, `top(N)`, or explicit codes.

## Dimension hierarchy in value labels

SSB uses the `¬` character to encode depth in value labels:

- `"Bygg og anlegg"` — depth 0
- `"¬ Boliger"` — depth 1 (child of above)
- `"¬¬ Eneboliger"` — depth 2

The UI strips these and converts to `padding-left` for visual indentation.

## Search architecture

Two search paths, selectable via "Smart søk (beta)" checkbox:

**Standard search** — Pure client-side substring matching:

```
query.toLowerCase() → match against table.label, table.id, table.variableNames
```

**Enhanced search** — Client-side scoring + server-side augmentation:

1. Build normalized index (once, cached on `BrowserState._searchIndex`)
2. Expand tokens via synonym groups (e.g. "bnp" → also try "bruttonasjonalprodukt")
3. Score each table: title start (30) > title contains (20) > ID (15) > variable (10) > path (8)
4. AND logic: every token must match somewhere
5. Server augmentation: API search finds tables by VALUE matches not in local list
6. Fuzzy fallback: if 0 results, retry with Lucene `~1` edit-distance

## Internationalisation (i18n)

`translations.js` is a self-contained i18n module loaded immediately after `config.js`. It manages all UI strings and the active language.

**Public API:**

- **`t(key)`** — returns the translation string for `key` in the current language, falling back to `nb`
- **`tpl(key, ...args)`** — same as `t()`, but replaces `{0}`, `{1}`, … placeholders with positional `args`
- **`setLanguage(code)`** — switches the active language and persists the choice to `localStorage`
- **`getCurrentApiLang()`** — returns the `apiLang` value for the active language (sent as `lang=` to the API)

**Language codes:** UI codes (`'nb'`, `'en'`) are distinct from API codes (`'no'`, `'en'`). The mapping lives in `AppConfig.languages`.

**Language selector:** If `AppConfig.languages` contains more than one entry, `index.html` renders language toggle buttons inside `#header-lang`. Clicking a button calls `setLanguage()` then `applyTranslatableUI()` (an inline function in `index.html`) which re-applies all static UI strings (tagline, footer labels, cache-clear link) without a full re-render.

**Instance-specific strings** (app name, source name, URLs) are in `AppConfig`, not in the translation dictionary, so the same `translations.js` works across different deployments.

## Stylesheets

CSS is split into three plain files (no preprocessor):

- **`css/main.css`** — Global layout, typography, header, footer, buttons, forms, and shared component styles. Defines all design tokens in `:root`.
- **`css/table.css`** — Styles specific to the data table display view: table container, controls bar, frozen headers, cell formatting, status symbols.
- **`css/menu-navigator.css`** — Styles for the front page, search view, topic browser, and navigation elements (subject grid, breadcrumbs, filter bar, search input, table list cards). Owns `.search-container`, `.search-input` (+ `:focus-visible`), `.filter-select`, `.no-results`, and `.info-message` — those selectors are intentionally defined only here even though they're not navigation-specific. `index.html` loads `menu-navigator.css` after `main.css`, so earlier duplicates in `main.css` were silently overridden until they were consolidated.

All three are loaded unconditionally via `<link>` tags in `index.html`.

### Design tokens

All design tokens live in `:root` in `main.css`:

- **Colors:** `--color-primary` (dark green, headers/fills), `--color-primary-light`, `--color-primary-dark`, `--color-secondary` (light green, active/interactive), `--color-accent`, `--color-background`, `--color-surface`, `--color-surface-alt`, `--color-border`, `--color-text`, `--color-text-light`, `--color-error`, `--color-success`.
- **Spacing:** `--spacing-{xs,sm,md,lg,xl,xxl}` (0.25rem → 3rem).
- **Borders:** `--border-radius-sm` (3px), `--border-radius` (4px), `--border-radius-lg` (8px).
- **Typography:** `--font-family`, `--font-mono`, `--font-size-{base,sm,lg,xl,xxl}`.
- **Shadows:** `--shadow-{sm,md,lg}`.
- **Transitions:** `--transition-default` (`0.2s ease`).

### Konvensjoner

- Use `var(--color-*)` for colors. Hardcoded hex codes are reserved for one-off tints (e.g. `#fafafa` backgrounds) and badge accents outside the palette (`#6c8ebf` beta-badge, `#ff9800` discontinued-badge).
- Focus styles use `:focus-visible` (not `:focus`) so the outline appears only on keyboard navigation. The accent colour is `var(--color-secondary)`, consistent with other active/interactive states.
- Transitions list animated properties explicitly — never `transition: all`. Use `var(--transition-default)` for timing.
- Media-query breakpoints are exactly two: **768px** (mobile) and **1100px** (narrow tablet). The convention is documented in a header comment in each CSS file.
- `!important` is avoided. The only remaining use is `.data-cell.highlighted` in `table.css` (needed to win over the `tr:nth-child(even)` zebra-stripe rule). State variants like `.btn-active` use chained pseudo-class selectors (`.btn-active, .btn-active:hover, .btn-active:focus-visible`) to win on specificity without `!important`.
- The data table sticky headers (`thead`, `.row-header`) rely on native `position: sticky` only — no `will-change`/`transform: translateZ(0)` hacks (which can break stickyness in nested scroll contexts).
- `main` has `max-width: 1700px` for all views; on the data table view it widens further to `1880px` (via `body[data-view="table"] main` in `table.css`) so wide tables can use more of a 1920+ screen. The `data-view` attribute is set on `<body>` by `renderCurrentView()` (`utils.js`) on every view transition. Components that benefit from being narrow (dialogs, the front-page search field) cap themselves locally.
- The table view also trims horizontal padding: `main` drops from `var(--spacing-xl)` (32px) to `var(--spacing-md)` (16px) and `.view-container` drops from `xl` to `lg` (24px), only when `data-view="table"`. Vertical padding is preserved. Effective table area on a 1920 screen ends up at ~1810px.
- Default data-cell padding is `var(--spacing-xs) var(--spacing-sm)` (4px vertical, 8px horizontal) — intentionally tight to let more data fit per row. `.data-table.compact` now differs only in `font-size`.
- Column headers wrap on long labels: `.col-header` uses `white-space: normal`, `max-width: 200px`, `overflow-wrap: break-word`, and `vertical-align: bottom`. The bottom-alignment keeps single-line and multi-line headers visually consistent across the same row. `min-width: 80px` is preserved so short headers ("År") don't collapse.

### Specificity pitfall — CSS dedup

When consolidating CSS rules, remember that the cascade merges properties across rules — not entire blocks. Two rules for the same selector may *each* contribute properties; removing one can drop properties that aren't redundant. The same applies in reverse to specificity: `.data-table .data-cell` (0,2,0) beats `.data-table td` (0,1,1), but plain `.data-cell` (0,1,0) does not. During the v1.4.2 cleanup, three regressions appeared from this: data-cell right-alignment, search-container margin-bottom, and info-message text-align/font-style. All are now resolved. Future dedups should: (a) enumerate properties of the rule being removed, (b) confirm each is either overridden elsewhere or genuinely unwanted, and (c) check the specificity of nearby rules that target overlapping elements.

## Shared utilities

`utils.js` provides several helpers used across views:

- **`addEscapeHandler(closeFn)`** — Registers a one-shot Escape key listener that closes a dialog. Returns a cleanup function. Used by the rotation dialog, export dialog, and save-query dialog.
- **`buildNavigationBreadcrumb(tableId, tableLabel)`** — Builds breadcrumb HTML from the topic path that led to the current table. Uses `AppState.navigationRef` (from topic navigation) or falls back to the table's first known path in the menu hierarchy.
- **`escapeHtml(text)`** — HTML-escapes user-supplied strings.
- **`formatNumber(value, decimals)`** — Formats numbers with Norwegian locale (space as thousands separator, comma as decimal).
- **`updatePageTitle(parts)`** — Sets the browser tab title dynamically per view.
