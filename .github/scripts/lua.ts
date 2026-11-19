// Static analysis of plugin Lua: which host functions (`chameleon.<namespace>.<function>`)
// a plugin can reach. It fails closed: any construct it cannot follow statically
// (dynamic indexing, the global table, loaders, metatables) is reported as a
// problem, so the PR goes to a human instead of the analysis guessing.
import { API_TIERS } from './api.ts'

type Token = { kind: 'name' | 'string' | 'number' | 'symbol'; value: string; line: number }

// Longest first, so `...` wins over `..` and `.`.
const SYMBOLS = ['...', '..', '==', '~=', '<=', '>=', '<<', '>>', '//', '::', ...'+-*/%^#&~|<>=(){}[];:,.']
const NAME = /[A-Za-z_]\w*/y
const NUMBER = /(?:\d|\.\d)(?:[eEpP][+-]|[\w.])*/y
const VALID_NUMBER = /^(?:0[xX](?:[\da-fA-F]+\.?[\da-fA-F]*|\.[\da-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/
const LONG_BRACKET = /\[(=*)\[/y

/** Splits Lua source into tokens, dropping whitespace and comments. Throws on malformed input. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  const fail = (message: string): never => {
    throw new Error(`line ${line}: ${message}`)
  }
  // Consumes a long bracket (`[[...]]`, `[==[...]==]`) at i and returns its content.
  const longBracket = (): string | undefined => {
    LONG_BRACKET.lastIndex = i
    const open = LONG_BRACKET.exec(source)
    if (!open) return undefined
    const close = `]${open[1]}]`
    const end = source.indexOf(close, i + open[0].length)
    if (end < 0) fail('unfinished long string or comment')
    const content = source.slice(i + open[0].length, end)
    line += content.split('\n').length - 1
    i = end + close.length
    return content
  }
  const quoted = (): string => {
    const quote = source[i]
    let j = i + 1
    while (source[j] !== quote) {
      if (source[j] === undefined || source[j] === '\n' || source[j] === '\r') fail('unfinished string')
      if (source[j] === '\\' && source[j + 1] === '\n') line++
      j += source[j] === '\\' ? 2 : 1
    }
    const value = source.slice(i + 1, j)
    i = j + 1
    return value
  }

  while (i < source.length) {
    const char = source[i]
    if (char === '\n') {
      line++
      i++
    } else if (' \t\r\f\v'.includes(char)) {
      i++
    } else if (source.startsWith('--', i)) {
      i += 2
      if (longBracket() === undefined) i = source.includes('\n', i) ? source.indexOf('\n', i) : source.length
    } else {
      const start = line
      tokens.push({ ...readToken(), line: start })
    }
  }
  return tokens

  function match(pattern: RegExp) {
    pattern.lastIndex = i
    const value = pattern.exec(source)?.[0]
    if (value !== undefined) i += value.length
    return value
  }
  function readToken(): Omit<Token, 'line'> {
    if (source[i] === '"' || source[i] === "'") return { kind: 'string', value: quoted() }
    const long = longBracket()
    if (long !== undefined) return { kind: 'string', value: long }
    const name = match(NAME)
    if (name !== undefined) return { kind: 'name', value: name }
    const number = match(NUMBER)
    if (number !== undefined) return VALID_NUMBER.test(number) ? { kind: 'number', value: number } : fail(`malformed number ${number}`)
    const symbol = SYMBOLS.find(s => source.startsWith(s, i))
    if (symbol === undefined) return fail(`unexpected character ${JSON.stringify(source[i])}`)
    i += symbol.length
    return { kind: 'symbol', value: symbol }
  }
}

/** Formats untrusted text as inline Markdown code, so it cannot format, link or @mention. */
export const code = (text: string) => `\`${text.replace(/[`\r\n]/g, ' ').replace(/\|/g, '\\|').slice(0, 200)}\``

// Ways to reach the global table, load unchecked code or tamper with values.
const BANNED = new Set(['load', 'loadstring', 'dofile', 'loadfile', '_ENV', '_G', 'getmetatable', 'setmetatable',
  'rawget', 'rawset', 'rawequal', 'rawlen', 'debug', 'package', 'io', 'os'])

export type Analysis = {
  /** Host calls referenced, as `namespace.function`. */
  calls: Set<string>
  /** Resource keys loaded with `require` or `chameleon.resources.require`. */
  requires: Set<string>
  problems: string[]
  /** Lines containing code (not blank or comment-only). */
  lines: number
}

/**
 * Analyzes one Lua chunk. Host functions may only be referenced statically, as
 * `chameleon.ns.fn` or through `local alias = chameleon.ns` followed by `alias.fn`.
 * Referencing a function counts as using it, whether it is called or passed on.
 */
export function analyzeLua(source: string): Analysis {
  const result: Analysis = { calls: new Set(), requires: new Set(), problems: [], lines: 0 }
  let tokens: Token[]
  try {
    tokens = tokenize(source)
  } catch (error) {
    result.problems.push(`cannot be parsed (${error instanceof Error ? error.message : error})`)
    return result
  }
  result.lines = new Set(tokens.map(token => token.line)).size

  const is = (i: number, kind: Token['kind'], value?: string) =>
    tokens[i]?.kind === kind && (value === undefined || tokens[i].value === value)
  const problem = (i: number, message: string) => result.problems.push(`line ${tokens[i].line}: ${message}`)
  // A name after `.` or `:` is a field of some value, not a variable.
  const isField = (i: number) => is(i - 1, 'symbol', '.') || is(i - 1, 'symbol', ':')

  // `require("key")`, `require "key"`, `require [[key]]`; i is the function name's token.
  const requireCall = (i: number) => {
    const arg = is(i + 1, 'string') ? i + 1 : is(i + 1, 'symbol', '(') && is(i + 2, 'string') && is(i + 3, 'symbol', ')') ? i + 2 : -1
    if (arg < 0 || tokens[arg].value.includes('\\')) problem(i, '`require` needs a plain string literal argument')
    else result.requires.add(tokens[arg].value)
  }
  // `<namespace>.fn` where i is the namespace's token (`chameleon.ns` or an alias).
  const member = (namespace: string, i: number, source: string) => {
    if (!is(i + 1, 'symbol', '.') || !is(i + 2, 'name')) return problem(i, `${source} must be followed by \`.function\``)
    const call = `${namespace}.${tokens[i + 2].value}`
    if (!API_TIERS.has(call)) problem(i, `unknown API ${code(`chameleon.${call}`)}`)
    result.calls.add(call)
    if (call === 'resources.require') requireCall(i + 2)
  }

  // `local alias = chameleon.ns`, recorded by the index of the `chameleon` token.
  const aliases = new Map<string, string>()
  const aliasDeclarations = new Map<number, number>()
  tokens.forEach((token, i) => {
    if (token.value !== 'chameleon' || token.kind !== 'name' || isField(i)) return
    const continues = ['.', '[', ':'].some(symbol => is(i + 3, 'symbol', symbol))
    if (!is(i - 3, 'name', 'local') || !is(i - 2, 'name') || !is(i - 1, 'symbol', '=') || !is(i + 1, 'symbol', '.') || !is(i + 2, 'name') || continues) return
    const alias = tokens[i - 2].value
    if (aliases.has(alias)) problem(i, `alias \`${alias}\` is declared more than once`)
    aliases.set(alias, tokens[i + 2].value)
    aliasDeclarations.set(i, i - 2)
  })
  const declarationNames = new Set(aliasDeclarations.values())

  tokens.forEach((token, i) => {
    if (token.kind !== 'name') return
    if (isField(i)) {
      if (token.value === 'dump') problem(i, '`string.dump` is not allowed')
      return
    }
    if (BANNED.has(token.value)) problem(i, `\`${token.value}\` is not allowed`)
    else if (token.value === 'require') requireCall(i)
    else if (token.value === 'chameleon') {
      if (!is(i + 1, 'symbol', '.') || !is(i + 2, 'name')) problem(i, '`chameleon` must be followed by `.namespace.function`')
      else if (is(i + 3, 'symbol', '.')) member(tokens[i + 2].value, i + 2, `\`chameleon.${tokens[i + 2].value}\``)
      else if (!aliasDeclarations.has(i)) problem(i, `\`chameleon.${tokens[i + 2].value}\` may only be stored with \`local name = chameleon.${tokens[i + 2].value}\``)
    } else if (aliases.has(token.value) && !declarationNames.has(i)) {
      member(aliases.get(token.value)!, i, `alias \`${token.value}\``)
    }
  })
  return result
}

/** Analyzes a plugin's code and every resource it loads as Lua, transitively. */
export function analyzePlugin(main: string, resources: Record<string, string>) {
  const result = { calls: new Set<string>(), problems: [] as string[], lines: 0 }
  const queue: [label: string, source: string][] = [['code', main]]
  const loaded = new Set<string>()
  for (const [label, source] of queue) {
    const analysis = analyzeLua(source)
    result.lines += analysis.lines
    analysis.calls.forEach(call => result.calls.add(call))
    result.problems.push(...analysis.problems.map(problem => `${label}, ${problem}`))
    for (const key of analysis.requires) {
      if (loaded.has(key)) continue
      loaded.add(key)
      if (Object.hasOwn(resources, key)) queue.push([`resource ${code(key)}`, resources[key]])
      else result.problems.push(`${label} requires missing resource ${code(key)}`)
    }
  }
  return result
}
