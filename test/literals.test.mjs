import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countLiterals, judgeLiterals, nextBaseline } from '../src/literals.mjs'

let dir
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-gates-literals-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.tsx'), [
    `export const fee = 250`,                  // counted
    `export const flags = [0, 1, 2]`,          // allowed numbers, but a list of literals: one list
    `export const mixed = [fee, 'x']`,         // not every element a literal: no list
    `export const neg = -40`,                  // counted
    `export const big = 1_000`,                // counted
    `// 999 in a comment`,
  ].join('\n'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('counts numbers outside the allowed set and lists of literals only', () => {
  assert.deepEqual(countLiterals(dir, ['src/a.tsx']), { 'src/a.tsx': { numbers: 3, lists: 1 } })
  assert.deepEqual(countLiterals(dir, ['src/a.tsx'], { allowed: [0, 1, 2, 250] }), { 'src/a.tsx': { numbers: 2, lists: 1 } })
})

test('refuses growth, a fall not written down, a new file above zero, and a gone path; passes equal counts', () => {
  const baseline = { 'src/a.tsx': 3, 'src/gone.tsx': 1 }
  const r = judgeLiterals({ 'src/a.tsx': { numbers: 3, lists: 1 }, 'src/new.tsx': { numbers: 1, lists: 0 } }, baseline)
  assert.deepEqual(r.grew, ['src/a.tsx: 4 (3 numbers, 1 lists), baseline 3', 'src/new.tsx: 1 (1 numbers, 0 lists), baseline 0'])
  assert.deepEqual(r.gone, ['src/gone.tsx'])
  assert.deepEqual(judgeLiterals({ 'src/a.tsx': { numbers: 2, lists: 0 }, 'src/gone.tsx': { numbers: 1, lists: 0 } }, baseline).fell, ['src/a.tsx: 2, baseline 3'])
  assert.deepEqual(judgeLiterals({ 'src/a.tsx': { numbers: 3, lists: 0 }, 'src/gone.tsx': { numbers: 0, lists: 1 } }, baseline), { grew: [], fell: [], gone: [] })
})

test('the next baseline carries a rename and never rises', () => {
  const { next, raised } = nextBaseline({ 'src/b.tsx': { numbers: 2, lists: 0 } }, { 'src/a.tsx': 3 }, new Map([['src/b.tsx', 'src/a.tsx']]))
  assert.deepEqual(next, { 'src/b.tsx': 2 })
  assert.deepEqual(raised, [])
  assert.deepEqual(nextBaseline({ 'src/a.tsx': { numbers: 4, lists: 0 } }, { 'src/a.tsx': 3 }).raised, ['src/a.tsx: 4, baseline 3'])
})
