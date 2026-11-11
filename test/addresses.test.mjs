import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hitsInFiles, judgeAddresses, pyHits } from '../src/addresses.mjs'
import { fileSet } from '../src/files.mjs'

// Every arm is shown refusing a planted literal and passing its look-alike. The planted hosts end in `.zz`, a label no
// registry delegates, so no real host is named; reserved names (`.example`, `.test`) would pass the gate instead.
let dir
const PLANTED = {
  'src/a.ts': [
    `export const to = 'someone@acme-widgets.zz'`,               // refused: an address
    `export const sample = 'someone@acme.example'`,             // passes: a reserved domain
    `// 'x@y.zz' in a comment`,                                 // passes: comments are not read
    `export const q = 'from:(Alerts@Bank.Example.net) newer'`,  // passes: a reserved domain, any case
    `export const vendor = 'billing@vendor.zz'`,                // passes: allowed by address
    `export const DOMAIN = 'acme-widgets.zz'`,                  // refused: a bare host whose top label the tree uses
    `export const perm = 'orders.write'`,                       // passes: a top label no URL uses
    `export const site = 'https://acme-widgets.zz/register'`,   // refused: a URL to a host not allowed
    `export const api = 'https://api.vendor.zz/v1'`,            // passes: an allowed host
    `export const apiPort = 'https://api.vendor.zz:8443/v1'`,   // passes: an allowed host on any port
    `export const local = 'http://127.0.0.1:3000/'`,            // passes: loopback
    `export const ip = '10.0.0.7'`,                             // refused: a bare IP
    `export const loop = '127.0.0.1'`,                          // passes: loopback
    `export const ok = (hostname: string) => hostname.endsWith('.internal')`, // refused: a zone suffix against a host
    `export const port = { port: 9999 }`,                       // refused: a port
    `import x from 'https://cdn.not-allowed.zz/x.js'`,          // passes: a module specifier
  ].join('\n'),
  'src/b.tsx': `export const P = () => <p>Sign in with your @acme-widgets.zz address</p>`, // refused: @host in prose
  'src/c.test.ts': `export const t = 'someone@acme-widgets.zz'`, // passes: tests are excluded
  'tools/d.py': `HOST = "https://acme-widgets.zz/x"\n# "https://comment.zz/"\n`,              // refused: Python, parsed
}
const LISTS = { allowedHosts: ['api.vendor.zz'], allowedAddresses: ['billing@vendor.zz'] }

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-gates-addresses-'))
  for (const [rel, code] of Object.entries(PLANTED)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), code + '\n')
  }
})
after(() => rmSync(dir, { recursive: true, force: true }))

const run = (pinned = []) => {
  const files = fileSet(dir, { include: ['src'], exclude: [/\.test\./], keep: n => /\.(ts|tsx)$/.test(n) })
  const hits = [...hitsInFiles(files, dir), ...pyHits(join(dir, 'tools'), dir)]
  const r = judgeAddresses(hits, { ...LISTS, pinned })
  return { ...r, list: r.findings.map(o => `${o.file}|${o.arm}|${o.literal}`).sort(), files }
}

test('reads the included directories and never an excluded test', () => {
  assert.deepEqual(run().files.map(f => f.slice(dir.length + 1)), ['src/a.ts', 'src/b.tsx'])
})

test('refuses each arm on a planted literal and passes its look-alikes', () => {
  assert.deepEqual(run().list, [
    'src/a.ts|bare-host|acme-widgets.zz',
    'src/a.ts|email|someone@acme-widgets.zz',
    'src/a.ts|ip|10.0.0.7',
    'src/a.ts|port|9999',
    'src/a.ts|url|https://acme-widgets.zz/register',
    'src/a.ts|zone|.internal',
    'src/b.tsx|email|@acme-widgets.zz',
    'tools/d.py|url|https://acme-widgets.zz/x',
  ])
})

test('a pin keyed by file and literal silences that literal alone, and a pin nothing earns is stale', () => {
  const r = run(['src/a.ts|someone@acme-widgets.zz', 'src/a.ts|gone@acme-widgets.zz'])
  assert.ok(!r.list.includes('src/a.ts|email|someone@acme-widgets.zz'))
  assert.deepEqual(r.stale, ['src/a.ts|gone@acme-widgets.zz'])
})
