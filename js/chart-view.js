/**
 * Chart View — line chart for time-series data.
 *
 * Converts a JSON-Stat2 response + the current table layout into a Chart.js
 * line chart. One dataset (line) per combination of non-time dimension values;
 * x-axis = the time dimension's categories in their declared order.
 *
 * Reuses buildDimensionCombinations() and calculateFlatIndex() from
 * table-display.js — both live on the global scope (no module system).
 */

let currentChart = null;

// SSB official categorical palette (ssb-dataviz skill). Used in fixed rank
// order so a chart's primary series is always SSB Grønn. After the 8 named
// ranks we wrap on SSB Grå (the "Andre"/nedtonet colour) — anything past the
// 8th line is, by definition, not the focus.
const SSB_PALETTE = [
  '#1A9D49', // 1. SSB Grønn (primær)
  '#1D9DE2', // 2. SSB Blå
  '#C78800', // 3. SSB Gull
  '#C775A7', // 4. SSB Rosa
  '#075745', // 5. SSB Mørk Grønn
  '#0F2080', // 6. SSB Mørk Blå
  '#A3136C', // 7. SSB Mørk Rosa
  '#471F00', // 8. SSB Mørk Brun
];
const SSB_GREY = '#909090';
const SSB_DARK = '#274247';   // axis/title text
const SSB_GRID = '#C3DCDC';   // light grid

const MAX_RECOMMENDED_LINES = 12;

/**
 * Return N palette colours. Ranks 1–8 follow the SSB sequence; anything beyond
 * falls back to SSB Grå so the eye reads them as "the rest".
 */
function getSeriesPalette(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(i < SSB_PALETTE.length ? SSB_PALETTE[i] : SSB_GREY);
  }
  return out;
}

/**
 * Format an ISO timestamp into a short Norwegian date (YYYY-MM-DD).
 * The skill's example uses ISO; matches table-metadata.js' "Sist oppdatert"
 * presentation closely enough without re-parsing locale.
 */
function _formatUpdated(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Build the source line: "Kilde: <source-name>, tabell <id>. Sist oppdatert: <date>".
 * Source name is read from AppConfig.source so the line stays correct on
 * non-SSB instances (SCB etc.). The label "tabell" / "Sist oppdatert" come
 * from translations for i18n.
 */
function buildSourceLine(data, tableId) {
  const srcName = AppConfig.source?.name || 'SSB';
  const updated = _formatUpdated(data.updated);
  let line = `${t('chart.source')}: ${srcName}, ${t('chart.tableWord')} ${tableId}`;
  if (updated) line += `. ${t('chart.lastUpdated')}: ${updated}`;
  return line;
}

/**
 * Convert JSON-Stat2 + layout into Chart.js datasets.
 *
 *  - The time dimension (data.role?.time?.[0]) drives the x-axis labels.
 *  - Every other dimension contributes one "line" per value combination.
 *  - status codes (".", "..", ":") render as null → Chart.js draws a gap.
 *  - When there are no non-time dimensions (or they all have size 1), there
 *    is exactly one line; we fall back to the short table title as its label
 *    (per project convention — single-line charts shouldn't show a blank legend).
 */
function buildChartData(data, _layout) {
  // _layout is accepted for API symmetry with the plan but unused — the chart
  // always puts time on the x-axis and every other dim as series, regardless
  // of how the table view happens to be pivoted.
  const timeDim = data.role?.time?.[0];
  if (!timeDim || !data.dimension[timeDim]) {
    return null;
  }

  // x-axis: time categories in their declared index order
  const timeDimObj = data.dimension[timeDim];
  const timeCodes = Object.keys(timeDimObj.category.index)
    .sort((a, b) => timeDimObj.category.index[a] - timeDimObj.category.index[b]);
  const xLabels = timeCodes.map(code => timeDimObj.category.label?.[code] || code);

  // Non-time dimensions → one dataset per value combination
  const nonTimeDims = data.id.filter(d => d !== timeDim);
  const combos = buildDimensionCombinations(nonTimeDims, data);

  // Metric dim drives per-dataset decimal precision. Per SSB convention,
  // decimals are unit[code].decimals (e.g. Personer1 → 0, KpiIndMnd → 1).
  // Hardcoding a default would mask real precision differences across charts.
  const metricDim = data.role?.metric?.[0];
  const metricDimIndex = metricDim ? nonTimeDims.indexOf(metricDim) : -1;
  const datasetDefaultDecimals = data.extension?.px?.decimals ?? 0;

  // For each combo × time period, compute the data value
  const datasets = combos.map(combo => {
    const labelParts = combo.codes.map((code, i) => {
      const dim = data.dimension[nonTimeDims[i]];
      return dim.category.label?.[code] || code;
    });

    // Single-line case (no non-time dims, or every non-time dim has size 1)
    // → user asked us to seed the label from the short table title.
    const tableTitle = data.extension?.px?.contents || data.label || '';
    const seriesLabel = labelParts.length > 0
      ? labelParts.join(' · ')
      : (tableTitle || t('chart.series'));

    // Decimal precision for this series. agg_ codelists on the metric dim
    // expose aggregate codes that aren't in unit{} — fall back to the
    // dataset-level default (extension.px.decimals) in that case.
    let decimals = datasetDefaultDecimals;
    if (metricDimIndex >= 0) {
      const metricCode = combo.codes[metricDimIndex];
      const unitDecimals = data.dimension[metricDim]?.category?.unit?.[metricCode]?.decimals;
      if (unitDecimals != null) decimals = unitDecimals;
    }

    const values = timeCodes.map(timeCode => {
      const timeIdx = timeDimObj.category.index[timeCode];
      const fullIndices = data.id.map(dimCode => {
        if (dimCode === timeDim) return timeIdx;
        const ntIdx = nonTimeDims.indexOf(dimCode);
        return combo.indices[ntIdx];
      });
      const flatIdx = calculateFlatIndex(fullIndices, data.size);
      if (data.status && data.status[String(flatIdx)] != null) return null;
      const v = data.value[flatIdx];
      return (v == null || !Number.isFinite(v)) ? null : v;
    });

    return { label: seriesLabel, data: values, decimals };
  });

  return { labels: xLabels, datasets, timeDim };
}

/**
 * Render the chart into `canvasEl`. Returns { tooManyLines: bool, lineCount }
 * so the caller can decide whether to show a "too many lines" warning above
 * the canvas.
 */
function renderChart(canvasEl, data, layout) {
  if (!canvasEl || !data) return { tooManyLines: false, lineCount: 0 };

  // Be tolerant of stale chart instances (e.g. after a fast toggle).
  destroyChart();

  const built = buildChartData(data, layout); // layout is forwarded for symmetry but ignored
  if (!built) return { tooManyLines: false, lineCount: 0 };

  const palette = getSeriesPalette(built.datasets.length);
  const datasets = built.datasets.map((ds, i) => ({
    label: ds.label,
    data: ds.data,
    decimals: ds.decimals, // custom property — read by tooltip & y-axis callbacks
    borderColor: palette[i],
    backgroundColor: palette[i],
    borderWidth: 2,
    pointRadius: 2,
    pointHoverRadius: 4,
    spanGaps: false, // honour the status-code gaps explicitly
    tension: 0,      // no smoothing — statistical series shouldn't be aestheticised
  }));

  // Y-axis precision must accommodate every series. If two metrics differ
  // (e.g. one with 0 decimals and one with 2), the larger value wins.
  const yAxisDecimals = datasets.reduce((m, d) => Math.max(m, d.decimals || 0), 0);

  const tableId = AppState.selectedTable?.id
    || data.extension?.px?.tableid
    || '';
  const title = data.extension?.px?.contents
    || data.label
    || extractTableTitle(AppState.selectedTable?.label || '');
  const sourceLine = buildSourceLine(data, tableId);

  currentChart = new Chart(canvasEl, {
    type: 'line',
    data: { labels: built.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: {
          display: !!title,
          text: title,
          position: 'top',
          color: SSB_DARK,
          font: { size: 16, weight: 'bold' },
          padding: { top: 4, bottom: 12 },
        },
        subtitle: {
          // Source line — mandated by the SSB dataviz skill. Lives inside the
          // canvas so it travels with any future PNG export of the chart.
          display: true,
          text: sourceLine,
          position: 'bottom',
          color: SSB_GREY,
          font: { size: 11 },
          padding: { top: 12, bottom: 0 },
        },
        legend: {
          position: 'bottom',
          labels: { color: SSB_DARK, boxWidth: 16, boxHeight: 2 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y, ctx.dataset.decimals ?? 0)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: SSB_DARK, autoSkip: true, maxRotation: 0 },
          grid: { display: false },
        },
        y: {
          beginAtZero: false, // line-chart convention — start where the data lives
          ticks: { color: SSB_DARK, callback: (v) => formatNumber(v, yAxisDecimals) },
          grid: { color: SSB_GRID, drawBorder: false },
        },
      },
    },
  });

  return {
    tooManyLines: datasets.length > MAX_RECOMMENDED_LINES,
    lineCount: datasets.length,
  };
}

/**
 * Tear down the current chart. Safe to call when no chart exists.
 * Must run before the canvas element is removed from the DOM, otherwise
 * Chart.js logs "Canvas is already in use" on the next render.
 */
function destroyChart() {
  if (currentChart) {
    currentChart.destroy();
    currentChart = null;
  }
}

// Debug hook — only when AppConfig.debug is on (matches the index.html pattern).
if (typeof AppConfig !== 'undefined' && AppConfig.debug) {
  window.chartView = { get currentChart() { return currentChart; }, buildChartData, getSeriesPalette };
}
