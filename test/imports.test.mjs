import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importVerdicts } from '../src/imports.mjs'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'source-gates.mjs')
const RULES = [{ name: 'database', modules: ['pg', 'src/lib/db'], allow: ['src/lib/**'] }]

let dir
const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-gates-imports-'))
  // No src/lib/db.ts on disk: resolution is by path alone.
  put('src/app/page.tsx', `import { db } from '@/lib/db'\nexport default function P() { return null }\n`)
  put('src/app/relative.ts', `import { db } from '../lib/db.ts'\n`)
  put('src/app/wire.ts', `import pg from 'pg'\n`)
  put('src/app/subpath.ts', `import { Client } from 'pg/lib/client'\n`)
  put('src/app/lazy.ts', `export async function f() { return import('@/lib/db') }\n`)
  put('src/app/old.cjs', `const pg = require('pg')\n`)
  put('src/app/bare.ts', `import '@/lib/db/index'\n`)
  put('src/app/reexport.ts', `export { db } from '@/lib/db'\n`)
  put('src/app/types.ts', `import type { Db } from '@/lib/db'\nimport { type Row } from 'pg'\nexport type { Db as D } from '@/lib/db'\n`)
  put('src/app/other.ts', `import pgx from 'pgx'\nimport { db } from '@/lib/dbx'\n`)
  put('src/lib/loader.ts', `import { db } from './db'\n`)
})
after(() => rmSync(dir, { recursive: true, force: true }))

const files = () => execFileSync('find', [join(dir, 'src'), '-type', 'f'], { encoding: 'utf8' }).trim().split('\n').sort()

test('refuses value imports outside the allowed files: static, relative, subpath, dynamic, require, bare, re-export', () => {
  const { hits } = importVerdicts(dir, files(), { rules: RULES, aliases: { '@/': 'src/' } })
  const refused = hits.filter(h => h.verdict === 'refused').map(h => h.file).sort()
  assert.deepEqual(refused, [
    'src/app/bare.ts', 'src/app/lazy.ts', 'src/app/old.cjs', 'src/app/page.tsx',
    'src/app/reexport.ts', 'src/app/relative.ts', 'src/app/subpath.ts', 'src/app/wire.ts',
  ])
  assert.deepEqual(hits.find(h => h.file === 'src/app/page.tsx'),
    { file: 'src/app/page.tsx', line: 1, specifier: '@/lib/db', module: 'src/lib/db', rule: 'database', verdict: 'refused' })
  assert.equal(hits.find(h => h.file === 'src/app/subpath.ts').module, 'pg')
})

test('passes type-only imports, other modules of a similar name, and the allowed files', () => {
  const { hits } = importVerdicts(dir, files(), { rules: RULES, aliases: { '@/': 'src/' } })
  for (const f of ['src/app/types.ts', 'src/app/other.ts']) assert.ok(!hits.some(h => h.file === f), f)
  assert.equal(hits.find(h => h.file === 'src/lib/loader.ts').verdict, 'allowed')
})

test('a pin holds a file; a pin that matches nothing is stale', () => {
  const { hits, stale } = importVerdicts(dir, files(), {
    rules: RULES, aliases: { '@/': 'src/' },
    pinned: new Map([['src/app/page.tsx|database', 'moving'], ['src/app/types.ts|database', 'nothing here']]),
  })
  assert.equal(hits.find(h => h.file === 'src/app/page.tsx').verdict, 'pinned')
  assert.deepEqual(stale, ['src/app/types.ts|database'])
})

test('the command fails on a refused import and lists every verdict', () => {
  put('source-gates.config.mjs', `export default { imports: { aliases: { '@/': 'src/' }, rules: ${JSON.stringify(RULES)} } }\n`)
  const run = args => { try { return { code: 0, out: execFileSync('node', [BIN, ...args, '--root', dir], { encoding: 'utf8', stdio: 'pipe' }) } } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` } } }
  const gate = run(['imports'])
  assert.equal(gate.code, 1)
  assert.match(gate.out, /src\/app\/page\.tsx:1 {2}@\/lib\/db {2}\(rule database\)/)
  const list = run(['imports', '--list'])
  assert.equal(list.code, 0)
  assert.match(list.out, /ALLOWED {2}database {2}src\/lib\/loader\.ts:1/)
  put('source-gates.config.mjs', `export default { imports: {} }\n`)
  assert.equal(run(['imports']).code, 2)
  put('source-gates.config.mjs', `export default { imports: { include: ['nowhere'], rules: ${JSON.stringify(RULES)} } }\n`)
  assert.equal(run(['imports']).code, 2)   // a gate that walks nothing does not read green
})
