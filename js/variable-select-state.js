/**
 * Variable Selection — Module State
 *
 * Shared mutable state used across all variable-select-*.js modules.
 * Must be loaded first in the variable-select file group.
 */

/**
 * Variable-select state, shared between all variable-select-*.js files.
 *
 * Fields:
 *   tableMetadata       — Full JSON-Stat2 metadata for the current table
 *   activeCodelists     — { DimCode: null | {
 *                            codelistId, elimination, isAggregated,
 *                            values: Array<{code, label, valueMap}>,
 *                            originalCodes: Set<string>
 *                          } }
 *                          When a codelist is active, the value list is re-rendered from
 *                          codelist data so values appear in the codelist's order. The
 *                          codelist's own elimination may override the dimension's default.
 *   dimensionValueOrder — { DimCode: ["code1","code2",...] }
 *                          Pre-loaded value ordering from the first codelist. Used by
 *                          renderValueList() so "Velg fritt" values follow codelist order
 *                          (codelist codes first, remaining after).
 *   lastClickedIndex    — { DimCode: N } for shift-click range selection
 *   urlUpdateTimer      — debounce timer ID for debouncedURLUpdate()
 */
const VarSelect = {
  tableMetadata: null,
  activeCodelists: {},
  dimensionValueOrder: {},
  lastClickedIndex: {},
  urlUpdateTimer: null,

  /**
   * Debounced URL update — avoids excessive history entries by batching
   * selection changes within 500ms into one navigateTo call.
   */
  debouncedURLUpdate() {
    clearTimeout(this.urlUpdateTimer);

    this.urlUpdateTimer = setTimeout(() => {
      if (!AppState.selectedTable) return;

      const params = {};

      const selection = getVariableSelection();
      if (selection && Object.keys(selection).length > 0) {
        params.v = URLRouter.encode(selection);
      }

      if (Object.keys(AppState.activeCodelistIds).length > 0) {
        params.c = URLRouter.encode(AppState.activeCodelistIds);
      }

      URLRouter.navigateTo(
        `variables/${AppState.selectedTable.id}`,
        params,
        false  // replaceState — don't create history entries per selection change
      );
    }, 500);
  }
};

/**
 * Whether a dimension plays the time role in the current table.
 * Prefers the JSON-Stat2 role.time declaration; falls back to a name
 * heuristic for tables that omit role metadata.
 *
 * @param {string} dimCode - Dimension code
 * @returns {boolean}
 */
function isTimeDimension(dimCode) {
  if (VarSelect.tableMetadata?.role?.time?.length) {
    return VarSelect.tableMetadata.role.time.includes(dimCode);
  }
  return dimCode === 'Tid' || dimCode.toLowerCase().includes('tid');
}
