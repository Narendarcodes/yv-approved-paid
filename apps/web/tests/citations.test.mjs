// Brand Brain citation chips: rule titles, never raw ids.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { citationHint, citationLabel } from '../src/lib/citations.ts'

const titleOf = (id) =>
  id === 'brand' ? 'Brand hub' : id === 'p1' ? 'Autumn teaser' : id.slice(-6)

test('a brand rule shows its title, not its id', () => {
  const c = {
    postId: 'brand',
    metric: 'brandRule',
    value: '6af0c1d2e3f4a5b6c7d8e9f0',
    note: 'Logo placement',
  }
  const label = citationLabel(c, titleOf)
  assert.equal(label, 'Brand hub · Logo placement')
  assert.ok(!label.includes('6af0'))
  assert.ok(!label.includes('='))
  assert.equal(citationHint(c), '')
})

test('a brand rule without a title still hides the id', () => {
  const label = citationLabel({ postId: 'brand', metric: 'brandRule', value: '6af0c1d2' }, titleOf)
  assert.equal(label, 'Brand hub · rule')
})

test('post metrics read as words and formatted numbers', () => {
  assert.equal(
    citationLabel({ postId: 'p1', metric: 'views', value: 12400 }, titleOf),
    'Autumn teaser · views 12,400',
  )
  assert.equal(
    citationLabel({ postId: 'p1', metric: 'engagementRate', value: 0.0712 }, titleOf),
    'Autumn teaser · engagement 7.1%',
  )
  assert.equal(
    citationLabel(
      { postId: 'p1', metric: 'viewsVsOrgMedian', value: 3.2, note: 'youtube median' },
      titleOf,
    ),
    'Autumn teaser · vs median 3.2×',
  )
  assert.equal(
    citationLabel({ postId: 'p1', metric: 'retention@0:42', value: 1.1 }, titleOf),
    'Autumn teaser · retention at 0:42 1.1',
  )
  assert.equal(
    citationHint({ postId: 'p1', metric: 'viewsVsOrgMedian', value: 3.2, note: 'youtube median' }),
    'youtube median',
  )
})
