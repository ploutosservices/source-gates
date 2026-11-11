// The one place this package turns source text into syntax trees.
//
// TypeScript 7 is a native compiler. Its npm package no longer exports the old compiler API
// (`ts.createSourceFile()`); it ships `typescript/unstable/*` instead: a client that starts the
// native compiler once, opens a project, and hands back each file's tree already parsed, with the
// node shapes, `parent` pointers, `getText()`, `getStart()` and `forEachChild()` the old API had.
//
// Its authors mark it UNSTABLE, so the version is pinned exactly in package.json and this file is
// the only one that knows the API's shape: a change in it lands here and nowhere else.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API } from 'typescript/unstable/sync'
import * as is from 'typescript/unstable/ast/is'

export { is }
export { SyntaxKind } from 'typescript/unstable/ast'

/** A string literal or a template literal with no substitution. */
export const isStringLiteralLike = n => is.isStringLiteral(n) || is.isNoSubstitutionTemplateLiteral(n)

/** Thrown when the parser cannot hand back a file; the CLI exits 2 on it. */
export class ParseError extends Error {}

/**
 * Parse the given files (absolute paths) and return their trees.
 *
 * The native compiler works on a project, so the files are written into a throw-away tsconfig
 * that names exactly them, with module resolution and lib loading off: this is a parse, not a
 * type-check, and it must not pull node_modules in.
 *
 * Every file asked for comes back or the call throws. A gate that silently sees fewer files than
 * it was given passes what it never read.
 *
 * Call `close()` when done: it stops the compiler process.
 *
 * @param {string} cwd    the project root the compiler runs in
 * @param {string[]} files absolute paths of .ts/.tsx/.mts/.js/.mjs files
 */
export function parseSources(cwd, files) {
  const dir = mkdtempSync(join(tmpdir(), 'source-gates-'))
  const config = join(dir, 'tsconfig.json')
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      allowJs: true, noEmit: true, noResolve: true, skipLibCheck: true,
      noLib: true, types: [], jsx: 'preserve', module: 'esnext', target: 'esnext',
    },
    files,
  }))
  const api = new API({ cwd })
  // Closing stops the compiler process, which may print "context canceled" on stderr as it goes; that line is
  // TypeScript's own shutdown message, not a failure.
  const cleanup = () => { api.close(); rmSync(dir, { recursive: true, force: true }) }
  let snapshot
  try {
    snapshot = api.updateSnapshot({ openProjects: [config] })
  } catch (e) {
    cleanup()
    throw new ParseError(`the TypeScript parser could not open the files: ${e.message}`)
  }
  const project = snapshot.getProjects()[0]
  if (!project) {
    snapshot.dispose(); cleanup()
    throw new ParseError('the TypeScript parser opened no project for the files')
  }
  const sources = new Map()
  const missing = []
  for (const f of files) {
    const sf = project.program.getSourceFile(f)
    if (sf) sources.set(f, sf); else missing.push(f)
  }
  if (missing.length) {
    snapshot.dispose(); cleanup()
    throw new ParseError(`the TypeScript parser returned no tree for ${missing.length} file(s):\n  ${missing.join('\n  ')}`)
  }
  return {
    sources,
    close() { snapshot.dispose(); cleanup() },
  }
}
