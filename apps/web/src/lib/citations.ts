/**
 * Readable labels for Brand Brain citation chips. The agent cites a brand-hub entry as
 * { postId: 'brand', metric: 'brandRule', value: <rule id>, note: <rule title> }; the reader
 * sees the title, never the id. Post metrics read as "<post> · views 12,400".
 */
export interface CitationLike {
  postId: string
  metric: string
  value: number | string
  note?: string | null
}

const METRIC_LABEL: Record<string, string> = {
  views: 'views',
  engagementRate: 'engagement',
  viewsVsOrgMedian: 'vs median',
  saveRate: 'save rate',
  reviewComments: 'review comments',
}

function formatValue(metric: string, value: number | string): string {
  if (typeof value !== 'number') return String(value)
  if (metric === 'engagementRate' || metric === 'saveRate') return `${(value * 100).toFixed(1)}%`
  if (metric === 'viewsVsOrgMedian') return `${value}×`
  return value.toLocaleString('en-US')
}

/** Chip text for one citation. `titleOf` maps a post id to its title. */
export function citationLabel(c: CitationLike, titleOf: (postId: string) => string): string {
  if (c.metric === 'brandRule') {
    const title = String(c.note || '').trim()
    return title ? `Brand hub · ${title}` : 'Brand hub · rule'
  }
  const metric = c.metric.startsWith('retention@')
    ? `retention at ${c.metric.slice('retention@'.length)}`
    : METRIC_LABEL[c.metric] || c.metric
  return `${titleOf(c.postId)} · ${metric} ${formatValue(c.metric, c.value)}`
}

/** Hover text: the rule title is already on the chip, so brand rules get none; metrics keep their note. */
export function citationHint(c: CitationLike): string {
  return c.metric === 'brandRule' ? '' : String(c.note || '')
}
