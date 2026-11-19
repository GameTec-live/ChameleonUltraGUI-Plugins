import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canAutoMerge, configuredOwners, labelsFor, review, type FileChange, type ReviewInput } from './review.ts'

const plugin = (code: string, name = 'Count cards') => JSON.stringify({
  format: 'chameleon-ultra-gui-plugin', version: 1, id: 'uuid', name, description: 'Counts cards.',
  color: 0, encoding: 'json', data: { code, resources: {} },
})
const update = (head: string, base = plugin('chameleon.ui.info(#chameleon.cards.list())')): FileChange =>
  ({ path: 'plugins/count.plugin.json', base, head, forkPoint: base, headMode: '100644' })
const input = (changes: FileChange[], overrides: Partial<ReviewInput> = {}): ReviewInput => ({
  author: 'alice', maintainer: false, firstTime: false, targetsDefaultBranch: true, owners: { count: ['Alice'] }, changes, ...overrides,
})

test('auto-merges an owner update that adds only read APIs', () => {
  const decision = review(input([update(plugin('chameleon.ui.snackbar(#chameleon.cards.list())'))]))
  assert.deepEqual(decision.attention, [])
  assert.deepEqual(decision.review, [])
  assert.ok(canAutoMerge(decision))
  assert.deepEqual([...labelsFor(decision, true)], ['size: small', 'auto-merged'])
})

test('flags an update that starts using a write or dangerous API', () => {
  const decision = review(input([update(plugin('chameleon.cards.delete(1)'))]))
  assert.match(decision.attention.join(), /starts using `cards.delete`/)
  assert.ok(labelsFor(decision, false).has('needs attention'))
})

test('sends updates of plugins with dangerous APIs to a human, even without new ones', () => {
  const dangerous = plugin('chameleon.device.factoryReset()')
  const decision = review(input([update(plugin('chameleon.device.factoryReset() chameleon.ui.info("done")'), dangerous)]))
  assert.deepEqual(decision.attention, [])
  assert.match(decision.review.join(), /dangerous APIs/)
})

test('flags updates by non-owners and obfuscated code', () => {
  assert.match(review(input([update(plugin('chameleon.ui.info(1)'))], { author: 'mallory' })).attention.join(), /not an owner/)
  assert.match(review(input([update(plugin('local f = load("x")'))])).attention.join(), /`load` is not allowed/)
})

test('labels new plugins for review, with their size', () => {
  const code = Array.from({ length: 50 }, (_, i) => `chameleon.ui.info("${i}")`).join('\n')
  const decision = review(input([{ path: 'plugins/new.plugin.json', head: plugin(code), headMode: '100644' }], { firstTime: true }))
  assert.equal(canAutoMerge(decision), false)
  assert.deepEqual([...labelsFor(decision, false)], ['needs review', 'new plugin', 'size: medium'])
})

test('reads owners a maintainer configured, ignoring malformed entries', () => {
  const config = JSON.stringify({ plugins: { count: { owners: ['alice', 7] }, other: { owners: 'bob' } } })
  assert.deepEqual(configuredOwners(config, 'count'), ['alice'])
  assert.deepEqual(configuredOwners(config, 'other'), [])
  assert.deepEqual(configuredOwners('not json', 'count'), [])
})

test('treats non-plugin files as unusual from contributors and routine from maintainers', () => {
  const change: FileChange = { path: '.github/workflows/marketplace.yml', base: 'a', head: 'b', forkPoint: 'a', headMode: '100644' }
  assert.equal(review(input([change])).attention.length, 1)
  const maintainer = review(input([change], { maintainer: true }))
  assert.deepEqual(maintainer.attention, [])
  assert.equal(maintainer.review.length, 1)
})

test('does not auto-merge when the base branch changed the file since the PR branched', () => {
  const change = { ...update(plugin('chameleon.ui.info(#chameleon.cards.list())')), forkPoint: 'older' }
  assert.match(review(input([change])).review.join(), /rebase/)
})
