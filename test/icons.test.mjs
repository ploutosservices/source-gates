import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { iconVerdicts } from '../src/icons.mjs'

let dir
const FILES = {
  'src/a.tsx': [
    `export const A = () => <div>`,
    `  <Tooltip text="saved"><CheckIcon /></Tooltip>`,      // covered: inside a wrapper
    `  <XIcon />`,                                         // bare
    `  <Lucide.BellIcon />`,                               // bare: a namespaced icon
    `  <Popover body="…"><span><InfoIcon /></span></Popover>`, // covered: a second wrapper, deeper
    `  <HelpIcon />`,                                      // covered: it labels itself
    `  <button title="close"><CloseIcon /></button>`,      // bare: title does not count
    `</div>`,
    `{/* <CommentIcon /> */}`,
  ].join('\n'),
  'src/help.tsx': `export function HelpIcon() { return <Tooltip text="help"><QuestionIcon /></Tooltip> }`,
  'src/plain.tsx': `export const P = () => <p>no icons</p>`,
}
const files = () => Object.keys(FILES).map(f => join(dir, f))

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-gates-icons-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const [f, s] of Object.entries(FILES)) writeFileSync(join(dir, f), s + '\n')
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('refuses an icon outside every wrapper; passes one inside, deeper inside, or one that labels itself', () => {
  const v = iconVerdicts(dir, files(), { wrappers: ['Tooltip', 'Popover'] })
  assert.deepEqual(v.bare.map(b => `${b.file}:${b.line} ${b.tag}`), [
    'src/a.tsx:3 XIcon', 'src/a.tsx:4 Lucide.BellIcon', 'src/a.tsx:7 CloseIcon',
  ])
  assert.deepEqual(v.selfLabelled, ['HelpIcon'])
  assert.equal(v.icons, 6)   // CheckIcon, XIcon, BellIcon, InfoIcon, CloseIcon, and QuestionIcon inside HelpIcon
})

test('an exempt file is skipped; an exemption for a file that renders no icon is stale', () => {
  const v = iconVerdicts(dir, files(), { wrappers: ['Tooltip', 'Popover'], exempt: { 'src/a.tsx': 'test', 'src/plain.tsx': 'test' } })
  assert.deepEqual(v.bare, [])
  assert.deepEqual(v.unusedExempt, ['src/plain.tsx'])
})
