import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleVerdicts } from '../src/bundle-secrets.mjs'

let dir
// Planted values, made at run time (a long one stands for a credential; none is real).
const planted = n => `planted-${n}-`.padEnd(32, 'x')
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-gates-bundle-'))
  mkdirSync(join(dir, '.next/static/chunks'), { recursive: true })
  mkdirSync(join(dir, '.next/server/chunks'), { recursive: true })
  writeFileSync(join(dir, '.env.local'), [
    `LEAKED_KEY="${planted(1)}"`, 'SHORT_KEY=abc', `KEPT_KEY=${planted(2)}`, 'NEXT_PUBLIC_SITE=https://site.example',
  ].join('\n'))
  writeFileSync(join(dir, '.next/static/chunks/app.js'), `var k="${planted(1)}";var s="abc";var p="https://site.example"`)
  writeFileSync(join(dir, '.next/server/chunks/srv.js'), `process.env.LEAKED_KEY;process.env.SHORT_KEY;process.env.NEXT_PUBLIC_SITE`)
})
after(() => rmSync(dir, { recursive: true, force: true }))

const declared = [
  { name: 'LEAKED_KEY', secret: true }, { name: 'SHORT_KEY', secret: true },
  { name: 'KEPT_KEY', secret: true }, { name: 'NEXT_PUBLIC_SITE' },
  { name: 'NEXT_PUBLIC_BUILT_IN' }, { name: 'READ_BY_FRAMEWORK', warnUnused: false },
]

test('a secret value in the static output leaks; a short value, a public name and a non-secret are not compared', () => {
  const v = bundleVerdicts(dir, { declared })
  assert.equal(v.ran, true)
  assert.deepEqual(v.leaked, ['LEAKED_KEY'])
  assert.equal(v.checkedValues, 2)
})

test('a declared name missing from the server chunks was inlined; a NEXT_PUBLIC_ name or a framework-read name is not checked', () => {
  assert.deepEqual(bundleVerdicts(dir, { declared }).inlined, ['KEPT_KEY'])
})

test('no build: the gate does not run', () => {
  const v = bundleVerdicts(dir, { declared, staticDir: 'nowhere' })
  assert.equal(v.ran, false)
})
