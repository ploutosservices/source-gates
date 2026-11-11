import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countPatterns } from '../src/patterns.mjs'
import { judgeRatchet, nextRatchet } from '../src/ratchet.mjs'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'source-gates.mjs')
const MATCH = ["===\\s*['\"]admin['\"]", '\\bisAdmin\\b']

let dir
const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }
const run = args => { try { return { code: 0, out: execFileSync('node', [BIN, ...args, '--root', dir], { encoding: 'utf8', stdio: 'pipe' }) } } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` } } }
const config = rule => put('source-gates.config.mjs', `export default { patterns: { rules: { roles: ${JSON.stringify(rule)} } } }\n`)

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-gates-patterns-'))
  put('src/a.ts', [
    `if (role === 'admin') go()`,          // counted
    `if (isAdmin(user)) go()`,             // counted
    `// isAdmin in a comment counts too`,  // counted: the gate reads text
    `const isAdministrator = true`,        // not a whole word
  ].join('\n'))
  put('src/lib/permissions.ts', `export const isAdmin = u => u.role === 'admin'\n`)
  put('src/a.test.ts', `isAdmin()\n`)
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('counts matching lines per file, comments included, a line once', () => {
  const { counts, lines } = countPatterns(dir, ['src/a.ts', 'src/lib/permissions.ts'], MATCH)
  assert.deepEqual(counts, { 'src/a.ts': 3, 'src/lib/permissions.ts': 1 })
  assert.deepEqual(lines, { 'src/a.ts': [1, 2, 3], 'src/lib/permissions.ts': [1] })
})

test('a RegExp given with the g or y flag misses no line', () => {
  // isAdmin on lines 2, 3 and 4 (isAdministrator: no word boundary here); admin on every line.
  assert.deepEqual(countPatterns(dir, ['src/a.ts'], [/isAdmin/g]).counts, { 'src/a.ts': 3 })
  assert.deepEqual(countPatterns(dir, ['src/a.ts'], [/isAdmin/y, /admin/gy]).counts, { 'src/a.ts': 4 })
})

test('a rule\'s files expression with the g flag skips no file', () => {
  const d = mkdtempSync(join(tmpdir(), 'source-gates-files-g-'))
  try {
    for (const n of ['a', 'b', 'c']) { mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, `src/${n}.ts`), 'isAdmin()\n') }
    writeFileSync(join(d, 'source-gates.config.mjs'), `export default { patterns: { rules: { r: { match: ['isAdmin'], include: ['src'], files: /\\.ts$/g } } } }\n`)
    const out = execFileSync('node', [BIN, 'patterns', '--list', '--root', d], { encoding: 'utf8' })
    assert.match(out, /3 matching lines/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('the ratchet: growth, a fall not written down, a gone path; the next baseline never rises unless it is the first', () => {
  const r = judgeRatchet({ 'src/a.ts': 3, 'src/new.ts': 1 }, { 'src/a.ts': 2, 'src/gone.ts': 1 })
  assert.deepEqual(r, { grew: ['src/a.ts: 3, baseline 2', 'src/new.ts: 1, baseline 0'], fell: [], gone: ['src/gone.ts'] })
  assert.deepEqual(judgeRatchet({ 'src/a.ts': 1 }, { 'src/a.ts': 2 }).fell, ['src/a.ts: 1, baseline 2'])
  assert.deepEqual(nextRatchet({ 'src/a.ts': 3 }, {}).raised, ['src/a.ts: 3, baseline 0'])
  assert.deepEqual(nextRatchet({ 'src/a.ts': 3 }, {}, new Map(), { first: true }), { next: { 'src/a.ts': 3 }, raised: [] })
})

test('the command: a first baseline, then a ban on growth, a fall to record, and a gone exemption', () => {
  config({ match: MATCH, include: ['src'], exempt: ['src/lib/permissions.ts'], message: 'use the permission check instead' })
  assert.match(run(['patterns']).out, /no baseline holds this rule yet/)
  assert.equal(run(['patterns', '--write-baseline']).code, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'source-gates.patterns.json'), 'utf8')), { roles: { 'src/a.ts': 3 } })
  assert.equal(run(['patterns']).code, 0)

  put('src/b.ts', `if (isAdmin(u)) x()\n`)
  const grew = run(['patterns'])
  assert.equal(grew.code, 1)
  assert.match(grew.out, /src\/b\.ts: 1, baseline 0 \(lines 1\)/)
  assert.match(grew.out, /use the permission check instead/)
  assert.equal(run(['patterns', '--write-baseline']).code, 1)  // never raised once a baseline exists
  rmSync(join(dir, 'src/b.ts'))

  put('src/a.ts', `if (role === 'admin') go()\n`)
  assert.match(run(['patterns']).out, /a count fell/)
  assert.equal(run(['patterns', '--write-baseline']).code, 0)
  assert.equal(run(['patterns']).code, 0)

  config({ match: MATCH, include: ['src'], exempt: ['src/lib/gone.ts'] })
  const gone = run(['patterns'])
  assert.equal(gone.code, 1)
  assert.match(gone.out, /exempt files that are gone/)
  config({ match: MATCH })
  assert.equal(run(['patterns']).code, 2)
  config({ match: MATCH, include: ['nowhere'] })
  assert.equal(run(['patterns']).code, 2)              // a gate that walks nothing does not read green
})

test('a rule added later is recorded on its own; an all-zero rule stays held; a removed rule is reported', () => {
  const two = `export default { patterns: { rules: {
    roles: ${JSON.stringify({ match: MATCH, include: ['src'], exempt: ['src/lib/permissions.ts'] })},
    debug: ${JSON.stringify({ match: ['console\\.debug'], include: ['src'] })} } } }\n`
  put('source-gates.config.mjs', two)
  rmSync(join(dir, 'source-gates.patterns.json'), { force: true })
  put('src/a.ts', `if (role === 'admin') go()\n`)
  assert.equal(run(['patterns', '--write-baseline']).code, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'source-gates.patterns.json'), 'utf8')), { roles: { 'src/a.ts': 1 }, debug: {} })

  put('src/c.ts', `console.debug('x')\n`)
  assert.equal(run(['patterns', '--write-baseline']).code, 1)  // debug is held at zero: never raised
  rmSync(join(dir, 'src/c.ts'))

  put('source-gates.config.mjs', two.replace("debug: {\"match\":[\"console\\\\.debug\"],\"include\":[\"src\"]}", 'extra: ' +
    JSON.stringify({ match: ['TODO'], include: ['src'] })))
  put('src/c.ts', `// TODO\n`)
  const added = run(['patterns', '--write-baseline'])
  assert.equal(added.code, 0, added.out)                        // a new rule's first write records today's count
  const stale = JSON.parse(readFileSync(join(dir, 'source-gates.patterns.json'), 'utf8'))
  assert.deepEqual(stale, { roles: { 'src/a.ts': 1 }, extra: { 'src/c.ts': 1 } })
  put('source-gates.patterns.json', JSON.stringify({ ...stale, debug: {} }))
  assert.match(run(['patterns']).out, /rules the configuration no longer has/)
  rmSync(join(dir, 'src/c.ts'))
})
