import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeLua, analyzePlugin } from './lua.ts'

const calls = (source: string) => [...analyzeLua(source).calls].sort()
const problems = (source: string) => analyzeLua(source).problems

test('records direct and aliased host calls, including functions passed as values', () => {
  const source = `
    local ui = chameleon.ui
    local ok, cards = pcall(chameleon.cards.list)
    ui.info("You have " .. #cards .. " cards")`
  assert.deepEqual(calls(source), ['cards.list', 'ui.info'])
  assert.deepEqual(problems(source), [])
})

test('ignores names inside strings and comments', () => {
  const source = `
    -- chameleon.cards.delete(1)
    --[==[ load(chameleon) ]] still a comment ]==]
    local s = "chameleon.device.factoryReset()" .. 'load' .. [[_ENV]]
    chameleon.ui.info(s)`
  assert.deepEqual(calls(source), ['ui.info'])
  assert.deepEqual(problems(source), [])
})

test('rejects dynamic or indirect access to the host API', () => {
  for (const source of [
    'chameleon["cards"].delete(1)',
    'chameleon.cards["del" .. "ete"](1)',
    'local c = chameleon; c.cards.delete(1)',
    'local t = {c = chameleon.cards}',
    'local cards = chameleon.cards; local f = cards; f.delete(1)',
    'local cards = chameleon.cards; cards[name](1)',
    'local x = load("return 1")',
    'local g = _ENV',
    'setmetatable({}, {})',
    'local d = string.dump(f)',
    'require(name)',
    'chameleon.nope.thing()',
  ]) {
    assert.notDeepEqual(problems(source), [], source)
  }
})

test('rejects shadowing or reusing an alias', () => {
  assert.notDeepEqual(problems('local ui = chameleon.ui\nlocal function f(ui) ui.info("x") end'), [])
  assert.notDeepEqual(problems('local ui = chameleon.ui\nlocal ui = chameleon.cards'), [])
})

test('reports unparseable code', () => {
  assert.match(problems('chameleon.ui.info("unterminated)')[0], /cannot be parsed/)
})

test('follows required resources transitively', () => {
  const result = analyzePlugin('local h = require("a.lua")\nchameleon.resources.require "b.lua"', {
    'a.lua': 'return require [[c.lua]]',
    'b.lua': 'chameleon.ui.info("b")',
    'c.lua': 'chameleon.cards.delete(1)',
  })
  assert.deepEqual([...result.calls].sort(), ['cards.delete', 'resources.require', 'ui.info'])
  assert.deepEqual(result.problems, [])
  assert.match(analyzePlugin('require("missing.lua")', {}).problems[0], /missing resource/)
})
