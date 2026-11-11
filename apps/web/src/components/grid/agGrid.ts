/**
 * AG Grid (Community, MIT) set-up shared by the money grids (/payables, /my-money).
 *
 * Only imported by lazily-loaded pages, so the grid stays out of the main bundle.
 * Modules are registered one by one (not AllCommunityModule) to keep the chunk
 * small. Styling uses the Theming API (themeQuartz.withParams): the grid injects
 * its own CSS from JS, so there is no ag-grid.css / ag-theme-*.css import to ship.
 * Tokens mirror DESIGN.md (warm paper, ink, one teal, hairlines, 12px radius).
 */
import {
  ModuleRegistry,
  ClientSideRowModelModule,
  RowSelectionModule,
  QuickFilterModule,
  CsvExportModule,
  CellStyleModule,
  RowStyleModule,
  TooltipModule,
  themeQuartz,
} from 'ag-grid-community'

let registered = false
export function registerGridModules() {
  if (registered) return
  ModuleRegistry.registerModules([
    ClientSideRowModelModule,
    RowSelectionModule,
    QuickFilterModule,
    CsvExportModule,
    CellStyleModule,
    RowStyleModule,
    // tooltipValueGetter on the money columns (My share) needs it; without it AG Grid errors #200 and the grid renders empty
    TooltipModule,
  ])
  registered = true
}
registerGridModules()

export const yvGridTheme = themeQuartz.withParams({
  accentColor: '#035E5E',
  backgroundColor: '#FFFFFF',
  foregroundColor: '#171310',
  cellTextColor: '#171310',
  textColor: '#171310',
  subtleTextColor: '#6B645E',
  borderColor: 'rgba(28,25,23,.10)',
  wrapperBorder: { color: 'rgba(28,25,23,.10)' },
  wrapperBorderRadius: 12,
  borderRadius: 6,
  headerBackgroundColor: '#F7F5F2',
  headerTextColor: '#57534E',
  headerFontSize: 10,
  headerFontWeight: 500,
  headerHeight: 40,
  rowHeight: 48,
  rowHoverColor: 'rgba(28,25,23,.025)',
  selectedRowBackgroundColor: '#E6F2F0',
  fontFamily: ['Figtree', 'system-ui', 'sans-serif'],
  fontSize: 13,
  spacing: 6,
  columnBorder: false,
  checkboxCheckedBackgroundColor: '#035E5E',
  checkboxCheckedBorderColor: '#035E5E',
  checkboxBorderRadius: 4,
  iconSize: 14,
})
