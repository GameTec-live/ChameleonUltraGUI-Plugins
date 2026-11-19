// Entry point of the plugin review workflow (.github/workflows/review.yml).
// Reads the PR's files with git (as data, never executing them), decides with
// review.ts, then labels, comments and merges through the GitHub REST API.
//
// Expects the base branch checked out with full history, the PR head commit
// fetched, and GITHUB_TOKEN plus the standard Actions environment variables.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { code } from './lua.ts'
import { COMMENT_MARKER, LABELS, PLUGIN_FILE, canAutoMerge, configuredOwners, labelsFor, renderComment, review, type Label } from './review.ts'

type PullRequestEvent = {
  pull_request: {
    number: number
    draft: boolean
    author_association: string
    user: { login: string }
    base: { ref: string }
    head: { sha: string }
  }
  repository: { default_branch: string }
}

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const event: PullRequestEvent = JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8'))
const pr = event.pull_request
const repository = env('GITHUB_REPOSITORY')

async function github<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`)
  return response.status === 204 ? (undefined as T) : response.json()
}

const git = (...args: string[]) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })

/** A file's content at a commit, or undefined when it does not exist there. */
function show(commit: string, path: string): string | undefined {
  try {
    return git('cat-file', 'blob', `${commit}:${path}`).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Owners of a plugin on the base branch: those listed in marketplace.config.json,
 * otherwise whoever filed the merged PR that added its file. Nobody has to
 * register; plugins added without a PR are owned by maintainers only.
 */
async function ownersOf(id: string, path: string): Promise<string[]> {
  const configured = configuredOwners(show('HEAD', 'marketplace.config.json'), id)
  if (configured.length) return configured
  const added = git('log', '--diff-filter=A', '--no-renames', '--format=%H', '-1', 'HEAD', '--', path).toString().trim()
  if (!added) return []
  const pulls = await github<{ merged_at: string | null; user: { login: string } }[]>('GET', `/commits/${added}/pulls`)
  return pulls.filter(pull => pull.merged_at).map(pull => pull.user.login)
}

const isLabel = (name: string): name is Label => Object.hasOwn(LABELS, name)

/** Creates missing bot labels, then makes the PR carry exactly `wanted` among them. */
async function syncLabels(wanted: Set<Label>) {
  const existing = new Set((await github<{ name: string }[]>('GET', '/labels?per_page=100')).map(label => label.name))
  for (const [name, style] of Object.entries(LABELS)) {
    if (!existing.has(name)) await github('POST', '/labels', { name, ...style }).catch(() => {}) // a parallel run may have created it
  }
  const current = await github<{ name: string }[]>('GET', `/issues/${pr.number}/labels`)
  for (const { name } of current) {
    if (isLabel(name) && !wanted.has(name)) await github('DELETE', `/issues/${pr.number}/labels/${encodeURIComponent(name)}`)
  }
  if (wanted.size) await github('POST', `/issues/${pr.number}/labels`, { labels: [...wanted] })
}

/** Creates or updates the bot's single review comment. */
async function upsertComment(body: string) {
  const comments = await github<{ id: number; body?: string; user: { login: string } }[]>('GET', `/issues/${pr.number}/comments?per_page=100`)
  const previous = comments.find(comment => comment.user.login === 'github-actions[bot]' && comment.body?.startsWith(COMMENT_MARKER))
  if (previous) await github('PATCH', `/issues/comments/${previous.id}`, { body })
  else await github('POST', `/issues/${pr.number}/comments`, { body })
}

async function main() {
  const head = pr.head.sha
  const forkPoint = git('merge-base', 'HEAD', head).toString().trim()
  const paths = git('diff', '--name-only', '--no-renames', '-z', forkPoint, head).toString().split('\0').filter(Boolean)
  const owners: Record<string, string[]> = {}
  for (const path of paths) {
    const id = PLUGIN_FILE.exec(path)?.[1]
    if (id !== undefined && show('HEAD', path) !== undefined) owners[id] = await ownersOf(id, path)
  }
  const decision = review({
    author: pr.user.login,
    maintainer: ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association),
    firstTime: ['FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'NONE'].includes(pr.author_association),
    targetsDefaultBranch: pr.base.ref === event.repository.default_branch,
    owners,
    changes: paths.map(path => ({
      path,
      base: show('HEAD', path),
      head: show(head, path),
      forkPoint: show(forkPoint, path),
      headMode: git('ls-tree', '-z', head, '--', path).toString().split(' ')[0] || undefined,
    })),
  })
  console.log(JSON.stringify(decision, null, 2))

  let merged = false
  if (canAutoMerge(decision) && !pr.draft) {
    try {
      // `sha` makes GitHub refuse the merge if the PR changed after this review.
      await github('PUT', `/pulls/${pr.number}/merge`, { sha: head, merge_method: 'squash' })
      merged = true
    } catch (error) {
      decision.review.push(`Automatic merge failed: ${code(String(error))}`)
    }
  }
  if (merged) {
    // Merges made with the workflow token start no push workflows, so rebuild marketplace.json explicitly.
    await github('POST', '/actions/workflows/marketplace.yml/dispatches', { ref: event.repository.default_branch }).catch(error => {
      decision.review.push(`Starting the Marketplace workflow failed, run it manually: ${code(String(error))}`)
    })
  }
  await syncLabels(labelsFor(decision, merged))
  await upsertComment(renderComment(decision, merged))
}

main().catch(async error => {
  // Fail closed and visibly: an unreviewed PR must never look like a clean one.
  console.error(error)
  process.exitCode = 1
  const run = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
  await github('POST', `/issues/${pr.number}/labels`, { labels: ['needs attention'] }).catch(console.error)
  await upsertComment(`${COMMENT_MARKER}\n### Plugin review\n\n🔴 **The review bot failed** ([log](${run})), so a maintainer has to look at this PR.`).catch(console.error)
})
