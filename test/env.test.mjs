import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeVars, isRequired, judgeEnv } from '../src/env.mjs'

let dir
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-gates-env-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), [
    `export const url = process.env.API_URL`,                        // bare, at module scope: required
    `export const port = process.env.PORT ?? '3000'`,                // literal default
    `export const mode = process.env['MODE'] || computeMode()`,      // computed fallback
    `export function f() { if (process.env.FEATURE_X) return 1 }`,   // guarded
    `export const on = process.env.DEBUG === 'true'`,                // comparison: guarded
    `export function g() { return mustEnv('DB_URL') }`,              // a required helper
    `// process.env.IN_A_COMMENT`,                                   // never read
    `function computeMode() { return 'x' }`,
    `function mustEnv(n: string) { return process.env[n]! }`,
  ].join('\n'))
  writeFileSync(join(dir, 'src/a.test.ts'), `const saved = process.env.ONLY_IN_TEST`)
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('reads every process.env read and every required-helper call, with default, guard and scope', () => {
  const code = codeVars(dir, ['src'], { requiredHelpers: ['mustEnv'] })
  assert.deepEqual([...code.keys()].sort(), ['API_URL', 'DB_URL', 'DEBUG', 'FEATURE_X', 'MODE', 'ONLY_IN_TEST', 'PORT'])
  assert.equal(code.get('PORT').default, '3000')
  assert.equal(code.get('MODE').default, '<computed>')
  assert.equal(code.get('FEATURE_X').guarded, true)
  assert.equal(code.get('DEBUG').guarded, true)
  assert.equal(code.get('API_URL').moduleScope, true)
  assert.equal(code.get('ONLY_IN_TEST').moduleScope, undefined)
  assert.deepEqual([...code].filter(([, v]) => isRequired(v)).map(([k]) => k).sort(), ['API_URL', 'DB_URL', 'ONLY_IN_TEST'])
})

test('a scan without the helper named does not see its calls', () => {
  assert.ok(!codeVars(dir, ['src']).has('DB_URL'))
})

test('an undeclared read fails; a declared variable nothing reads warns, unless declared as read elsewhere', () => {
  const code = codeVars(dir, ['src'], { requiredHelpers: ['mustEnv'] })
  const r = judgeEnv(code, {
    declared: [
      { name: 'API_URL' }, { name: 'PORT' }, { name: 'MODE' }, { name: 'FEATURE_X' }, { name: 'DEBUG' },
      { name: 'DB_URL', secret: true }, { name: 'UNREAD_SECRET', secret: true }, { name: 'READ_BY_FRAMEWORK', warnUnused: false },
    ],
  })
  assert.deepEqual(r.undeclared, [{ name: 'ONLY_IN_TEST', file: 'src/a.test.ts' }])
  assert.deepEqual(r.unused, ['UNREAD_SECRET'])
})

test('an absent directory is tolerated beside one that exists; a scan with none to read stops', () => {
  assert.equal(codeVars(dir, ['src', 'does-not-exist']).size, 6)   // no helper named, so DB_URL is not seen
  assert.throws(() => codeVars(dir, ['does-not-exist']), e => e.exitCode === 2)
})

test('a read inside a class property, setter or static block is not at module scope', () => {
  writeFileSync(join(dir, 'src/b.ts'), [
    `export class A { k = process.env.IN_PROPERTY; set v(x: string) { process.env.IN_SETTER } static { process.env.IN_STATIC } }`,
  ].join('\n'))
  const code = codeVars(dir, ['src'])
  for (const n of ['IN_PROPERTY', 'IN_SETTER', 'IN_STATIC']) assert.equal(code.get(n).moduleScope, undefined, n)
})
