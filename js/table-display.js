/**
 * Table Display - Fetch and display table data
 */

// Store current data and metadata
let currentData = null;
let currentFullMetadata = null;

// Which content the table view is showing right now. Survives table re-renders
// (e.g. after rotation) so the chart stays selected; reset to 'table' when
// the user navigates away (back-to-browser / back-to-variables).
let viewMode = 'table';   // 'table' | 'chart'

/**
 * Render the table display view
 * @param {HTMLElement} container - Container element
 */
async function renderTableDisplay(container) {
  logger.log('[TableDisplay] Rendering table display');

  // The container is about to be overwritten — kill any chart that was
  // attached to a now-orphan canvas (e.g. after a language switch that
  // re-entered this view). Safe no-op when no chart exists.
  destroyChart();

  if (!AppState.selectedTable || !AppState.variableSelection) {
    showError(t('error.noTableOrSel'));
    URLRouter.navigateTo('home', {});
    URLRouter.handleRoute();
    return;
  }

  const table = AppState.selectedTable;
  updatePageTitle([extractTableTitle(table.label)]);

  await BrowserState.init();

  // If we arrived via direct link/refresh, the label was a placeholder — update it now
  const realTable = BrowserState.allTables.find(t => t.id === table.id);
  if (realTable) {
    AppState.selectedTable.label = realTable.label;
    updatePageTitle([extractTableTitle(table.label)]);
  }

  container.innerHTML = `
    <div class="view-container">
      <div class="view-header">
        <div class="view-header-buttons">
          <button id="back-to-browser" class="btn-secondary">
            ${t('nav.back.tables')}
          </button>
          <button id="back-to-variables" class="btn-secondary">
            ${t('nav.back.variables')}
          </button>
        </div>
        ${buildNavigationBreadcrumb(table.id, extractTableTitle(table.label))}
        <h2>${escapeHtml(extractTableTitle(table.label))}</h2>
        <p class="table-id-display">${t('table.prefix')} ${escapeHtml(table.id)}</p>
      </div>

      <div id="data-container" class="data-container">
        <p class="loading-message">${t('loading.data')}</p>
      </div>
    </div>
  `;

  // Set up back buttons
  document.getElementById('back-to-browser')?.addEventListener('click', () => {
    destroyChart();
    viewMode = 'table';
    currentData = null;
    currentFullMetadata = null;
    const ref = AppState.navigationRef || 'home';
    AppState.resetTableState();
    const [route, qs] = ref.split('?');
    const params = Object.fromEntries(new URLSearchParams(qs || ''));
    URLRouter.navigateTo(route, params);
    URLRouter.handleRoute();
  });

  document.getElementById('back-to-variables')?.addEventListener('click', () => {
    destroyChart();
    viewMode = 'table';
    AppState.setView('variables');
  });

  // Fetch and display data
  await loadTableData();
}

/**
 * Load table data from API.
 *
 * The selection object (AppState.variableSelection) may not contain entries
 * for all dimensions. Dimensions with extension.elimination=true that the user
 * left unselected are intentionally omitted, causing the API to aggregate
 * across all values for those dimensions (they won't appear in the result).
 */
async function loadTableData() {
  const tableId = AppState.selectedTable.id;
  const selection = AppState.variableSelection;

  logger.log('[TableDisplay] Fetching data for table:', tableId);
  logger.log('[TableDisplay] Variable selection:', selection);

  // Use pre-fetched data if available (e.g. from saved query parallel fetch).
  // Consume and clear immediately so subsequent navigations always re-fetch.
  let data;
  if (AppState.tableData) {
    logger.log('[TableDisplay] Using pre-fetched data for table:', tableId);
    data = AppState.tableData;
    AppState.tableData = null;
  } else {
    data = await safeApiCall(
      () => api.getTableData(tableId, selection, getCurrentApiLang(), AppState.activeCodelistIds),
      t('error.fetchData')
    );
  }

  if (!data || !data.value) {
    logger.error('[TableDisplay] Invalid data format:', data);
    const container = document.getElementById('data-container');
    if (container) {
      container.innerHTML = '<p class="error-message">' + t('error.fetchData') + '</p>';
    }
    return;
  }

  if (data.value.length === 0) {
    const container = document.getElementById('data-container');
    if (container) {
      container.innerHTML = '<p class="no-results">' + t('error.noData') + '</p>';
    }
    return;
  }

  currentData = data;

  // Fetch full metadata (from cache) for display
  try {
    currentFullMetadata = await api.getTableMetadata(tableId, true, getCurrentApiLang());
    // Update title if it was set as a placeholder during direct URL navigation
    if (currentFullMetadata?.label && AppState.selectedTable) {
      AppState.selectedTable.label = currentFullMetadata.label;
      const h2 = document.querySelector('.view-header h2');
      if (h2) h2.textContent = extractTableTitle(currentFullMetadata.label);
      const bc = document.querySelector('.breadcrumb-current');
      if (bc) bc.textContent = AppState.selectedTable.id + ' ' + extractTableTitle(currentFullMetadata.label);
    }
  } catch (e) {
    logger.warn('[TableDisplay] Could not load full metadata:', e);
    currentFullMetadata = null;
  }

  logger.log('[TableDisplay] Data loaded:', data);
  logger.log('[TableDisplay] Dimensions:', data.id);
  logger.log('[TableDisplay] Sizes:', data.size);
  logger.log('[TableDisplay] Values:', data.value.length);

  // Determine layout: use pre-set layout (e.g. from saved query or URL param) if it
  // has meaningful content AND covers exactly the same dimensions as the current data.
  // If the dimension set has changed (e.g. user added/removed an optional variable),
  // recalculate from scratch so no dimension is silently missing or stale.
  const existingLayout = AppState.tableLayout;
  const allDataDims = [...data.id].sort();
  const layoutDims = existingLayout
    ? [...(existingLayout.rows || []), ...(existingLayout.columns || [])].sort()
    : [];
  const hasValidPresetLayout = existingLayout &&
    (existingLayout.rows.length > 0 || existingLayout.columns.length > 0) &&
    JSON.stringify(allDataDims) === JSON.stringify(layoutDims);

  if (!hasValidPresetLayout) {
    AppState.tableLayout = determineDefaultLayout(data);
  }

  // Display the data
  displayData();
}

/**
 * Determine default layout for table.
 *
 * Two modes, switched on the product of selected non-time dimension sizes:
 *
 *   Compact mode (product < 16): ALL non-time dims go to columns, with
 *     Statistikkvariabel on top and the rest narrowest-first beneath it.
 *     Time runs down the rows. Each metric × breakdown combination gets
 *     its own column, so a small table reads comfortably left-to-right.
 *
 *   Standard mode (product ≥ 16): only Statistikkvariabel + the narrowest
 *     non-time dim go to columns; time + any wider non-time dims go to
 *     rows. Keeps the column count tractable on wide tables.
 *
 * In both modes Statistikkvariabel is the first column entry → renders as
 * the topmost <th> row.
 *
 * Falls back gracefully when role.metric or role.time is absent.
 *
 * @param {object} data - JSON-Stat2 data
 * @returns {object} - Layout object with rows and columns arrays
 */
function determineDefaultLayout(data) {
  const dimensions = data.id;

  if (dimensions.length === 0) return { rows: [], columns: [] };
  if (dimensions.length === 1) return { rows: [], columns: dimensions };

  const metricDim = data.role?.metric?.[0];
  const timeDim = data.role?.time?.[0];
  const sizeByDim = Object.fromEntries(dimensions.map((d, i) => [d, data.size[i]]));

  // Non-metric, non-time dims sorted narrowest-first.
  const nonMetricNonTime = dimensions
    .filter(d => d !== metricDim && d !== timeDim)
    .sort((a, b) => sizeByDim[a] - sizeByDim[b]);

  // Product of all non-time selected counts. Defines how wide the column
  // axis would become if we stacked every non-time dim there.
  const nonTimeProduct = dimensions
    .filter(d => d !== timeDim)
    .reduce((acc, d) => acc * sizeByDim[d], 1);

  let columns, rows;
  if (nonTimeProduct < 16) {
    columns = metricDim ? [metricDim, ...nonMetricNonTime] : nonMetricNonTime;
    rows = timeDim ? [timeDim] : [];
  } else {
    columns = [];
    if (metricDim) columns.push(metricDim);
    if (nonMetricNonTime.length > 0) columns.push(nonMetricNonTime[0]);
    rows = dimensions.filter(d => !columns.includes(d));
  }

  // Degenerate: no row dim (no time dim, or every dim was claimed by cols).
  // Demote the last (narrowest) col to a row so the table has a vertical
  // axis. Statistikkvariabel stays in cols because it's never the last one
  // in the ordered list.
  if (rows.length === 0 && columns.length > 0) {
    rows = [columns.pop()];
  }

  return { rows, columns };
}

/**
 * Display the data as a table
 */
function displayData() {
  const container = document.getElementById('data-container');
  if (!container || !currentData) return;

  // Tear down any previous chart instance before swapping innerHTML —
  // otherwise Chart.js logs "Canvas is already in use" when the user
  // toggles back into chart mode after a rotation/re-render.
  destroyChart();

  // Build metadata section
  let html = buildMetadataSection();

  // Chart toggle is only meaningful for time-series tables. Hide it
  // entirely when there's no time role (e.g. cross-section snapshots,
  // or selections where time was eliminated).
  const hasTimeDim = !!currentData.role?.time?.[0];

  // Build control bar
  html += `
    <div class="table-controls">
      <div class="control-group">
        <button id="rotate-table-btn" class="btn-secondary">
          ${t('table.rotate')}
        </button>
        ${hasTimeDim ? `
          <button id="chart-toggle-btn" class="btn-secondary${viewMode === 'chart' ? ' btn-active' : ''}"
                  title="${escapeHtml(t('chart.toggleTitle'))}"
                  aria-pressed="${viewMode === 'chart'}">
            ${t('chart.toggle')}
          </button>
        ` : ''}
        <button id="export-quick-btn" class="btn-primary">
          ${t('table.download')}
        </button>
        <button id="export-btn" class="btn-secondary">
          ${t('table.moreOptions')}
        </button>
        <button id="save-query-btn" class="btn-secondary">
          ${t('table.getLink')}
        </button>
      </div>
      <div class="table-info">
        <span id="cell-count-display"></span>
      </div>
    </div>
  `;

  // Body: chart or table
  if (viewMode === 'chart' && hasTimeDim) {
    // Reserve a slot above the canvas for the >12-lines warning so we can
    // populate it after Chart.js reports the actual line count.
    html += `
      <p id="chart-warning" class="chart-warning info-message" style="display:none;"></p>
      <div class="chart-container">
        <canvas id="chart-canvas"></canvas>
      </div>
    `;
  } else {
    html += buildHtmlTable();
  }

  container.innerHTML = html;

  // Set up event listeners
  document.getElementById('rotate-table-btn')?.addEventListener('click', () => {
    openRotationDialog();
  });

  document.getElementById('chart-toggle-btn')?.addEventListener('click', () => {
    viewMode = (viewMode === 'chart') ? 'table' : 'chart';
    displayData();
  });

  // Render the chart after the DOM is in place. Chart.js needs the canvas
  // to be sized (the .chart-container fixes its height), and we want to
  // show/hide the >12-line warning based on the actual dataset count.
  if (viewMode === 'chart' && hasTimeDim) {
    const canvas = document.getElementById('chart-canvas');
    const result = renderChart(canvas, currentData, AppState.tableLayout);
    if (result.tooManyLines) {
      const warn = document.getElementById('chart-warning');
      if (warn) {
        warn.textContent = tpl('chart.tooManyLines', result.lineCount);
        warn.style.display = '';
      }
    }
  }

  document.getElementById('save-query-btn')?.addEventListener('click', () => {
    showSaveQueryDialog();
  });

  document.getElementById('export-quick-btn')?.addEventListener('click', () => {
    quickExportXlsx();
  });

  document.getElementById('export-btn')?.addEventListener('click', () => {
    showExportDialog();
  });

  // Set up metadata toggle
  const metaToggle = container.querySelector('.metadata-toggle-btn');
  if (metaToggle) {
    metaToggle.addEventListener('click', () => {
      const content = container.querySelector('.metadata-content');
      const icon = metaToggle.querySelector('.metadata-toggle-icon');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.innerHTML = '&#9660;';
        metaToggle.setAttribute('aria-expanded', 'true');
      } else {
        content.style.display = 'none';
        icon.innerHTML = '&#9654;';
        metaToggle.setAttribute('aria-expanded', 'false');
      }
    });
    metaToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        metaToggle.click();
      }
    });
  }

  // Update cell count
  updateCellCount();
}

/**
 * Build HTML table from data
 * @returns {string} - HTML table
 */
function buildHtmlTable() {
  if (!currentData || !AppState.tableLayout) {
    return '<p class="error-message">' + t('error.buildTable') + '</p>';
  }

  const data = currentData;
  const layout = AppState.tableLayout;

  // Get dimension info
  const rowDims = layout.rows;
  const colDims = layout.columns;

  // Build row and column headers
  const rowHeaders = buildDimensionCombinations(rowDims, data);
  const colHeaders = buildDimensionCombinations(colDims, data);

  // Precompute metric dimension lookup for decimal formatting (constant across all cells)
  const metricDim = data.role?.metric?.[0];
  const metricRowIdx = metricDim != null ? layout.rows.indexOf(metricDim) : -1;
  const metricColIdx = metricDim != null ? layout.columns.indexOf(metricDim) : -1;
  const tableDefaultDecimals = data.extension?.px?.decimals ?? null;
  const metricUnit = metricDim != null ? data.dimension[metricDim]?.category?.unit : null;

  logger.log('[TableDisplay] Row headers:', rowHeaders.length);
  logger.log('[TableDisplay] Column headers:', colHeaders.length);

  // Start building table
  let html = '<div class="table-wrapper"><table class="data-table">';

  // Build column header rows
  if (colDims.length > 0) {
    html += '<thead>';

    // One row for each column dimension
    colDims.forEach((dimCode, dimIndex) => {
      html += '<tr>';

      // Corner cell spanning all row-header columns (omit if there are no row dims)
      if (dimIndex === 0 && rowDims.length > 0) {
        html += '<th colspan="' + rowDims.length + '" rowspan="' + colDims.length + '"' +
                ' class="corner-cell">&nbsp;</th>';
      }

      // Column headers
      const dimension = data.dimension[dimCode];
      const dimLabel = dimension.label || dimCode;

      // Group headers by dimension level
      let prevGroup = null;
      let groupSpan = 0;

      colHeaders.forEach((colHeader, colIndex) => {
        const currentGroup = colHeader.codes[dimIndex];

        if (prevGroup !== null && currentGroup !== prevGroup) {
          // Output previous group
          const label = data.dimension[dimCode].category.label[prevGroup];
          html += '<th colspan="' + groupSpan + '" class="col-header">' +
                  escapeHtml(label) + '</th>';
          groupSpan = 0;
        }

        groupSpan++;
        prevGroup = currentGroup;

        // Last column - output current group
        if (colIndex === colHeaders.length - 1) {
          const label = data.dimension[dimCode].category.label[prevGroup];
          html += '<th colspan="' + groupSpan + '" class="col-header">' +
                  escapeHtml(label) + '</th>';
        }
      });

      html += '</tr>';
    });

    html += '</thead>';
  }

  // Build data rows
  html += '<tbody>';

  rowHeaders.forEach(rowHeader => {
    html += '<tr>';

    // Row header cells
    rowDims.forEach((dimCode, dimIndex) => {
      const code = rowHeader.codes[dimIndex];
      const label = data.dimension[dimCode].category.label[code];
      html += '<th class="row-header">' + escapeHtml(label) + '</th>';
    });

    // Data cells
    colHeaders.forEach(colHeader => {
      const status = getDataStatus(rowHeader, colHeader);
      if (status) {
        html += '<td class="data-cell suppressed-value" title="' + escapeHtml(suppressedLabel(status)) + '">' + escapeHtml(status) + '</td>';
      } else {
        const value = getDataValue(rowHeader, colHeader);
        const metricCode = metricRowIdx !== -1 ? rowHeader.codes[metricRowIdx]
                         : metricColIdx !== -1 ? colHeader.codes[metricColIdx]
                         : undefined;
        const decimals = resolveMetricDecimals(metricDim, metricCode, metricUnit, tableDefaultDecimals);
        html += '<td class="data-cell">' + formatNumber(value, decimals) + '</td>';
      }
    });

    html += '</tr>';
  });

  html += '</tbody>';
  html += '</table></div>';

  return html;
}

/**
 * Resolve the decimals setting for a metric cell.
 *
 * The straightforward lookup is `unit[metricCode].decimals`. That works for
 * vs_ codelists (subset of originals — code is present in unit{}) and for
 * tables without any codelist. It breaks for agg_ codelists: the API returns
 * data keyed by aggregate codes (e.g. "AGG_TOTAL"), but the unit{} map is
 * keyed by the underlying original codes, so the direct lookup misses and
 * per-metric precision silently falls back to the table-wide default.
 *
 * Fallback path: walk the active agg_ codelist's valueMap to find the
 * underlying originals for this aggregate, and pick the max of their decimals
 * — under-displaying precision loses information silently; trailing zeros
 * are visible and recoverable.
 */
function resolveMetricDecimals(metricDim, metricCode, metricUnit, tableDefaultDecimals) {
  if (metricCode === undefined || !metricUnit) return tableDefaultDecimals;

  const direct = metricUnit[metricCode]?.decimals;
  if (direct != null) return direct;

  // Aggregate-code path: look up the underlying originals via the active codelist.
  const codelistInfo = (typeof VarSelect !== 'undefined') ? VarSelect.activeCodelists?.[metricDim] : null;
  if (codelistInfo?.isAggregated) {
    const aggValue = codelistInfo.values.find(v => v.code === metricCode);
    const candidates = (aggValue?.valueMap || [])
      .map(orig => metricUnit[orig]?.decimals)
      .filter(d => d != null);
    if (candidates.length) return Math.max(...candidates);
  }

  return tableDefaultDecimals;
}

/**
 * Build all combinations of dimension values
 * @param {Array} dimCodes - Dimension codes
 * @param {object} data - JSON-Stat2 data
 * @returns {Array} - Array of combination objects
 */
function buildDimensionCombinations(dimCodes, data) {
  if (dimCodes.length === 0) {
    return [{ codes: [], indices: [] }];
  }

  let combinations = [{ codes: [], indices: [] }];

  dimCodes.forEach(dimCode => {
    const dimension = data.dimension[dimCode];
    if (!dimension) {
      logger.warn('[TableDisplay] Skipping unknown dimension in layout:', dimCode);
      return;
    }
    const codes = Object.keys(dimension.category.index);

    const newCombinations = [];

    combinations.forEach(combo => {
      codes.forEach(code => {
        const index = dimension.category.index[code];
        newCombinations.push({
          codes: [...combo.codes, code],
          indices: [...combo.indices, index]
        });
      });
    });

    combinations = newCombinations;
  });

  return combinations;
}

/**
 * Get data value for specific row/column combination
 * @param {object} rowHeader - Row header combination
 * @param {object} colHeader - Column header combination
 * @returns {number|null} - Data value
 */
function getDataValue(rowHeader, colHeader) {
  if (!currentData) return null;

  const layout = AppState.tableLayout;
  const data = currentData;

  // Build full dimension indices array
  const fullIndices = [];

  data.id.forEach(dimCode => {
    const rowIndex = layout.rows.indexOf(dimCode);
    const colIndex = layout.columns.indexOf(dimCode);

    if (rowIndex !== -1) {
      fullIndices.push(rowHeader.indices[rowIndex]);
    } else if (colIndex !== -1) {
      fullIndices.push(colHeader.indices[colIndex]);
    } else {
      // Shouldn't happen
      fullIndices.push(0);
    }
  });

  // Calculate flat index
  const flatIndex = calculateFlatIndex(fullIndices, data.size);

  return data.value[flatIndex];
}

/**
 * Get suppressed-value status code for a cell (JSON-stat2 `status` field)
 * @param {object} rowHeader - Row header combination
 * @param {object} colHeader - Column header combination
 * @returns {string|null} - Status symbol (e.g. ".", ":", "..") or null
 */
function getDataStatus(rowHeader, colHeader) {
  if (!currentData || !currentData.status) return null;

  const layout = AppState.tableLayout;
  const data = currentData;

  const fullIndices = [];
  data.id.forEach(dimCode => {
    const rowIndex = layout.rows.indexOf(dimCode);
    const colIndex = layout.columns.indexOf(dimCode);
    if (rowIndex !== -1) {
      fullIndices.push(rowHeader.indices[rowIndex]);
    } else if (colIndex !== -1) {
      fullIndices.push(colHeader.indices[colIndex]);
    } else {
      fullIndices.push(0);
    }
  });

  const flatIndex = calculateFlatIndex(fullIndices, data.size);
  return data.status[String(flatIndex)] ?? null;
}

/**
 * Return a Norwegian label for a JSON-stat2 suppressed-value status code
 * @param {string} code - Status code
 * @returns {string}
 */
function suppressedLabel(code) {
  // SSB JSON-stat2 status conventions:
  //   "."  = ikke mulig å oppgi tall (not applicable)
  //   ".." = tallgrunnlag mangler   (not available)
  //   ":"  = konfidensielt          (confidential)
  switch (code) {
    case '.':  return t('table.notApplicable');
    case '..': return t('table.notAvailable');
    case ':':  return t('table.confidential');
    default:   return code;
  }
}

/**
 * Calculate flat array index from dimension indices
 * @param {Array} indices - Index for each dimension
 * @param {Array} sizes - Size of each dimension
 * @returns {number} - Flat index
 */
function calculateFlatIndex(indices, sizes) {
  let flatIndex = 0;
  let multiplier = 1;

  // Process dimensions in reverse order (last dimension changes fastest)
  for (let i = sizes.length - 1; i >= 0; i--) {
    flatIndex += indices[i] * multiplier;
    multiplier *= sizes[i];
  }

  return flatIndex;
}

/**
 * Update cell count display
 */
function updateCellCount() {
  const display = document.getElementById('cell-count-display');
  if (!display || !currentData) return;

  const totalCells = currentData.value.length;
  display.textContent = formatNumber(totalCells, 0) + ' ' + t('unit.cell.many');
}

