// Decides what happens to a pull request: merge automatically, or label it for
// a human. Pure: main.ts gathers the inputs from git and applies the result.
//
// A PR merges automatically only when all of these hold:
// - it changes nothing but existing plugin files owned by its author,
// - no plugin starts using a write or dangerous API, and none uses a dangerous one,
// - names, descriptions and IDs stay the same, and every plugin passes analysis.
// Everything else gets "needs attention" (unusual) or "needs review" (routine).
import { gunzipSync } from 'node:zlib'
import { API_TIERS, TIERS } from './api.ts'
import { analyzePlugin, code } from './lua.ts'

export const LABELS = {
  'needs attention': { color: 'd73a4a', description: 'Something unusual; see the plugin review comment' },
  'needs review': { color: 'fbca04', description: 'Waiting for a routine review by a maintainer' },
  'new plugin': { color: '1d76db', description: 'Adds a plugin' },
  'size: small': { color: 'c2e0c6', description: 'Up to 40 lines of plugin code' },
  'size: medium': { color: 'fef2c0', description: 'Up to 200 lines of plugin code' },
  'size: large': { color: 'f9d0c4', description: 'More than 200 lines of plugin code' },
  'auto-merged': { color: '6f42c1', description: 'Merged automatically by the plugin review' },
} as const satisfies Record<string, { color: string; description: string }>
export type Label = keyof typeof LABELS
const SIZES = [[40, 'size: small'], [200, 'size: medium'], [Infinity, 'size: large']] as const satisfies [number, Label][]

export type FileChange = {
  path: string
  /** Content on the base branch now; undefined when absent. */
  base?: string
  /** Content in the PR; undefined when deleted. */
  head?: string
  /** Content where the PR branched off; differs from `base` when the base branch moved on. */
  forkPoint?: string
  /** Git file mode in the PR, e.g. `100644`. */
  headMode?: string
}

export type ReviewInput = {
  /** GitHub login of the PR author. */
  author: string
  /** Has write access to the repository; implicitly owns every plugin. */
  maintainer: boolean
  firstTime: boolean
  targetsDefaultBranch: boolean
  /** GitHub logins owning each existing plugin touched by the PR (see main.ts). */
  owners: Record<string, string[]>
  changes: FileChange[]
}

export type PluginReport = {
  id: string
  change: 'added' | 'updated' | 'deleted'
  /** Lines of Lua; undefined when the plugin could not be read. */
  lines?: number
  calls: string[]
  /** Calls the base branch's version did not use. */
  added: string[]
}

export type Decision = { attention: string[]; review: string[]; plugins: PluginReport[] }

export const PLUGIN_FILE = /^plugins\/([^/]+)\.plugin\.json$/
const MiB = 1024 * 1024

export function review(input: ReviewInput): Decision {
  const attention: string[] = []
  const routine: string[] = []
  const plugins: PluginReport[] = []
  // Unusual from a contributor, routine from a maintainer.
  const unusual = (reason: string) => (input.maintainer ? routine : attention).push(reason)
  const author = code(input.author)

  const isOwner = (id: string) =>
    input.maintainer || (input.owners[id] ?? []).some(owner => owner.toLowerCase() === input.author.toLowerCase())

  if (input.firstTime) routine.push(`First contribution by ${author}`)
  if (!input.targetsDefaultBranch) routine.push('Targets a branch other than the default branch')

  for (const change of input.changes) {
    const file = code(change.path)
    const id = PLUGIN_FILE.exec(change.path)?.[1]
    if (change.forkPoint !== change.base) routine.push(`${file} changed on the base branch since this PR branched off; rebase to merge automatically`)
    if (change.head !== undefined && change.headMode !== '100644') attention.push(`${file} is not a regular file`)
    else if (change.path === 'marketplace.json') routine.push('`marketplace.json` is regenerated after merging; please leave it out of the PR')
    else if (id === undefined) unusual(`Changes ${file}`)
    else plugins.push(reviewPlugin(id, change))
  }
  return { attention, review: routine, plugins }

  function reviewPlugin(id: string, change: FileChange): PluginReport {
    const name = code(id)
    if (change.head === undefined) {
      (isOwner(id) ? routine : attention).push(`Deletes plugin ${name}`)
      return { id, change: 'deleted', calls: [], added: [] }
    }
    const isNew = change.base === undefined
    const report: PluginReport = { id, change: isNew ? 'added' : 'updated', calls: [], added: [] }
    let plugin: Plugin
    try {
      plugin = parsePlugin(change.head)
    } catch (error) {
      attention.push(`${name} is not a valid plugin: ${code(String(error instanceof Error ? error.message : error))}`)
      return report
    }
    const analysis = analyzePlugin(plugin.code, plugin.resources)
    attention.push(...analysis.problems.map(problem => `${name}: ${problem}`))
    report.lines = analysis.lines
    report.calls = [...analysis.calls].sort()
    if (plugin.compressed) routine.push(`${name} is compressed; rebuild it with \`"compress": false\` so its diff can be reviewed`)
    const dangerous = report.calls.filter(call => API_TIERS.get(call) === 'dangerous')
    if (dangerous.length) routine.push(`${name} uses dangerous APIs, so every change needs a human: ${dangerous.map(code).join(', ')}`)

    if (isNew) {
      report.added = report.calls
      routine.push(`Adds plugin ${name}`)
      return report
    }

    if (!isOwner(id)) attention.push(`${author} is not an owner of ${name}`)
    const previous = tryParsePlugin(change.base)
    const previousCalls = previous ? analyzePlugin(previous.code, previous.resources).calls : new Set<string>()
    report.added = report.calls.filter(call => !previousCalls.has(call))
    const escalations = report.added.filter(call => API_TIERS.get(call) !== 'read')
    if (escalations.length) attention.push(`${name} starts using ${escalations.map(code).join(', ')}`)
    if (previous && (previous.name !== plugin.name || previous.description !== plugin.description || previous.id !== plugin.id)) {
      routine.push(`${name} changes its name, description or ID`)
    }
    return report
  }

}

export const canAutoMerge = (decision: Decision) =>
  decision.attention.length === 0 && decision.review.length === 0 && decision.plugins.length > 0

export function labelsFor(decision: Decision, merged: boolean): Set<Label> {
  const labels = new Set<Label>()
  if (decision.attention.length) labels.add('needs attention')
  if (decision.review.length) labels.add('needs review')
  if (decision.plugins.some(plugin => plugin.change === 'added')) labels.add('new plugin')
  const measured = decision.plugins.filter(plugin => plugin.lines !== undefined)
  if (measured.length) {
    const lines = measured.reduce((sum, plugin) => sum + (plugin.lines ?? 0), 0)
    labels.add(SIZES.find(([max]) => lines <= max)![1])
  }
  if (merged) labels.add('auto-merged')
  return labels
}

export const COMMENT_MARKER = '<!-- plugin-review -->'

/** The bot's PR comment: outcome, reasons and each plugin's API use. */
export function renderComment(decision: Decision, merged: boolean): string {
  const headline = decision.attention.length ? '🔴 **Needs attention.** Something here is unusual, so a maintainer has to look at it.'
    : decision.review.length ? '🟡 **Needs review.** A maintainer will review this PR.'
    : merged ? '🟢 **Merged automatically.**'
    : canAutoMerge(decision) ? '🟢 All checks pass. This PR merges automatically once it is ready for review.'
    : 'No plugin changes found.'
  const list = (title: string, items: string[]) => items.length ? `**${title}**\n\n${items.map(item => `- ${item}`).join('\n')}` : ''
  const cell = (plugin: PluginReport, tier: string) => plugin.calls
    .filter(call => (API_TIERS.get(call) ?? 'dangerous') === tier)
    .map(call => plugin.added.includes(call) && plugin.change === 'updated' ? `**${code(call)}** (new)` : code(call))
    .join(', ') || '–'
  const table = decision.plugins.length ? [
    `| Plugin | Change | Lines | ${TIERS.map(tier => tier[0].toUpperCase() + tier.slice(1)).join(' | ')} |`,
    `| --- | --- | --: | ${TIERS.map(() => '---').join(' | ')} |`,
    ...decision.plugins.map(plugin => `| ${code(plugin.id)} | ${plugin.change} | ${plugin.lines ?? '–'} | ${TIERS.map(tier => cell(plugin, tier)).join(' | ')} |`),
  ].join('\n') : ''
  const footer = '<sub>Updates by a plugin\'s owners merge automatically unless they add write or dangerous APIs. See `.github/MAINTAINING.md` for details.</sub>'
  return [COMMENT_MARKER, '### Plugin review', headline, list('Needs attention', decision.attention), list('Needs review', decision.review), table, footer]
    .filter(Boolean).join('\n\n')
}

type Plugin = { id?: string; name: string; description: string; compressed: boolean; code: string; resources: Record<string, string> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isTextRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(item => typeof item === 'string')

/** Parses a plugin file in the GUI's portable format, with the GUI's size limits. Throws if invalid. */
export function parsePlugin(text: string): Plugin {
  // main.ts decodes leniently; a replacement character may hide bytes the GUI reads differently.
  if (text.includes('�')) throw new Error('contains invalid UTF-8 (or U+FFFD)')
  if (Buffer.byteLength(text) > 16 * MiB) throw new Error('larger than 16 MiB')
  const envelope: unknown = JSON.parse(text)
  if (!isRecord(envelope) || envelope.format !== 'chameleon-ultra-gui-plugin' || envelope.version !== 1) {
    throw new Error('not a chameleon-ultra-gui-plugin version 1 file')
  }
  const { id, name, description, encoding } = envelope
  if (typeof name !== 'string' || !name.trim()) throw new Error('name is missing')
  if (typeof description !== 'string' || !description.trim()) throw new Error('description is missing')
  if (id !== undefined && typeof id !== 'string') throw new Error('id must be a string')
  let data = envelope.data
  if (encoding === 'gzip+base64') {
    if (typeof data !== 'string') throw new Error('compressed data must be a string')
    data = JSON.parse(gunzipSync(Buffer.from(data, 'base64'), { maxOutputLength: 8 * MiB }).toString('utf8'))
  } else if (encoding !== 'json') {
    throw new Error('encoding must be json or gzip+base64')
  }
  if (!isRecord(data) || typeof data.code !== 'string' || !isTextRecord(data.resources)) {
    throw new Error('data must hold code and text resources')
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 8 * MiB) throw new Error('code and resources exceed 8 MiB')
  return { id, name, description, compressed: encoding !== 'json', code: data.code, resources: data.resources }
}

function tryParsePlugin(text: string | undefined) {
  try {
    return text === undefined ? undefined : parsePlugin(text)
  } catch {
    return undefined
  }
}

/**
 * Owners a maintainer listed in `marketplace.config.json` (`plugins.<id>.owners`),
 * which replace the plugin's original submitter. Empty when none or invalid.
 */
export function configuredOwners(configText: string | undefined, id: string): string[] {
  try {
    const config: unknown = JSON.parse(configText ?? '{}')
    const entry = isRecord(config) && isRecord(config.plugins) ? config.plugins[id] : undefined
    const owners = isRecord(entry) ? entry.owners : undefined
    return Array.isArray(owners) ? owners.filter(owner => typeof owner === 'string') : []
  } catch {
    return []
  }
}
