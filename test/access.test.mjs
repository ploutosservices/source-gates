import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accessVerdicts, accessFiles } from '../src/access.mjs'

// A gate never shown failing is a gate nobody knows can fail. The fixture tree holds entries that check, entries that
// do not, a guard that only pretends to, and a forbidden name used; this asserts exactly which are refused.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/access')

const CONFIG = {
  primitive: 'can',
  guards: {
    requireThing: { file: 'src/lib/guards.ts', refuses: true },
    requireNothing: { file: 'src/lib/guards.ts', refuses: true },
  },
  declared: { 'src/app/public/page.tsx': 'public, for the test', 'src/app/gone/page.tsx': 'an entry that no longer exists' },
  pinned: { 'src/app/gated/page.tsx': 'a pin on an entry that checks' },
  forbiddenNames: { isSuperUser: ['src/lib/permissions.ts'] },
  extraAnswer: ({ file }) => file.endsWith('hooked/page.tsx') ? { reason: 'extraAnswer answers', names: ['op.one'] } : null,
}
const v = accessVerdicts(FIXTURE, accessFiles(FIXTURE), CONFIG)
const how = Object.fromEntries(v.entries.map(e => [e.file, e.how]))

test('refuses an entry that checks nothing: a check that only decides a link, a check named in a comment, a server action or a route handler under a checking layout, a server action whose directive follows a comment', () => {
  assert.deepEqual(v.silent.sort(), [
    'src/app/api/thing/route.ts',
    'src/app/commented-action/actions.ts',
    'src/app/covered/inner/actions.ts',
    'src/app/covered/inner/route.ts',
    'src/app/display-only/page.tsx',
    'src/app/silent/page.tsx',
  ])
})

test('passes a refusal on the primitive directly or through its variable, a covering layout for a page, a declaration, extraAnswer', () => {
  assert.equal(how['src/app/gated/page.tsx'], 'checks')
  assert.equal(how['src/app/through-variable/page.tsx'], 'checks')
  assert.equal(how['src/app/covered/inner/page.tsx'], 'layout src/app/covered/layout.tsx')
  assert.equal(how['src/app/covered/inner/route.ts'], null)
  assert.equal(how['src/app/public/page.tsx'], 'declared: public, for the test')
  assert.equal(how['src/app/hooked/page.tsx'], 'extraAnswer answers')
  assert.deepEqual(v.entries.find(e => e.file === 'src/app/hooked/page.tsx').names, ['op.one'])
})

test('refuses a forbidden name outside its files, and a listed file that no longer mentions it', () => {
  assert.deepEqual(v.forbiddenUses, ['isSuperUser: src/app/flag/page.tsx:3', 'isSuperUser: src/app/flag/page.tsx:5'])
  assert.deepEqual(v.unusedAllowances, ['isSuperUser: src/lib/permissions.ts'])
})

test('refuses a pin on an entry that checks and a declaration for an entry that is gone', () => {
  assert.deepEqual(v.unusedPins, ['src/app/gated/page.tsx'])
  assert.deepEqual(v.unusedDeclared, ['src/app/gone/page.tsx'])
})

test('refuses a guard whose own body does not check, even beside one that does', () => {
  assert.deepEqual(v.problems, ['guard requireNothing: src/lib/guards.ts — its body calls neither can() nor another guard'])
})

test('cannot run on a tree with no app directory, or with a list where a map is needed', () => {
  assert.throws(() => accessVerdicts(FIXTURE, [], { ...CONFIG, appDir: 'app' }), e => e.exitCode === 2)
  assert.throws(() => accessVerdicts(FIXTURE, [], { ...CONFIG, pinned: ['src/app/silent/page.tsx'] }), e => e.exitCode === 2)
})
