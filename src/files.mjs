// The one directory walk the gates share (Node's fs.globSync, stable since 22.17).
//
// Two properties on purpose:
//   * a missing directory THROWS (ENOENT). globSync alone answers [] for a directory that is not
//     there, and a gate that walks nothing reads green on nothing. A caller that tolerates absence
//     catches ENOENT itself.
//   * the answer is sorted, so output does not reorder with the filesystem's directory order.
import { globSync, statSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Every file under `dir`, recursively, each path `join(dir, relative)`.
 * @param {string} dir
 * @param {{ skip?: (name: string) => boolean, keep?: (name: string) => boolean }} [rules]
 *   skip — an entry (file or directory) by this name is not entered; keep — a file by this name is listed
 * @returns {string[]}
 */
export function filesUnder(dir, { skip = () => false, keep = () => true } = {}) {
  statSync(dir)
  return globSync('**/*', { cwd: dir, exclude: p => skip(basename(p)) })
    .map(rel => join(dir, rel))
    .filter(p => keep(basename(p)) && statSync(p).isFile())
    .sort()
}

/** Source-file extensions (declaration files excluded), and the default pattern for test files, which the gates leave out. */
export const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
export const isSourceFile = n => SOURCE_FILE.test(n) && !/\.d\.[cm]?ts$/.test(n)
export const DEFAULT_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** Entries never read: node_modules, dist, .next, and any file or directory whose name starts with a dot. */
export const skipCommon = n => n === 'node_modules' || n === 'dist' || n === '.next' || n.startsWith('.')

/**
 * The files of a gate's file set: every file under each `include` directory (relative to root) that `keep` accepts,
 * plus each existing `includeFiles` entry, minus every path `exclude` matches (relative, forward slashes).
 * An include directory that does not exist is skipped (unlike filesUnder, which throws), so a shared default such as
 * ['src', 'scripts'] fits a project that lacks one of them.
 * @param {string} root
 * @param {{ include?: string[], includeFiles?: string[], exclude?: (RegExp|string)[], keep: (name: string) => boolean, skip?: (name: string) => boolean }} set
 */
export function fileSet(root, { include = [], includeFiles = [], exclude = [], keep, skip = skipCommon }) {
  const rx = exclude.map(e => e instanceof RegExp ? e : new RegExp(e))
  const rel = f => f.slice(root.length + 1).split('\\').join('/')
  const out = []
  for (const d of include) {
    const abs = join(root, d)
    if (existsSync(abs)) out.push(...filesUnder(abs, { skip, keep }))
  }
  for (const f of includeFiles) {
    const abs = join(root, f)
    if (existsSync(abs)) out.push(abs)
  }
  return [...new Set(out)].filter(f => !rx.some(r => r.test(rel(f)))).sort()
}
