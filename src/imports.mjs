// THE IMPORTS GATE: named modules may be value-imported only by the files a rule allows.
//
// A boundary between layers — only the data layer talks to the database client, only one module talks to a vendor's
// SDK — holds only while nothing outside the layer imports what is behind it. A rule names the modules and the files
// that may import them; every other file that imports one by value is refused.
//
// A type import is not a reach across the boundary: it carries no code, and a change behind it already breaks the
// type check. `import type`, `export type`, and a named clause whose every binding is type-marked are exempt.
// Resolution is by path alone: no file is looked for on disk.
import { dirname, matchesGlob, relative, resolve, sep } from 'node:path'
import { parseSources, is, SyntaxKind } from './parse.mjs'

const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const posix = p => p.split(sep).join('/')
const isBare = s => !s.startsWith('.') && !s.startsWith('/')

/** True when the declaration carries no value. */
function typeOnly(decl) {
  if (is.isExportDeclaration(decl)) {
    if (decl.isTypeOnly) return true
    const ec = decl.exportClause
    return !!ec && is.isNamedExports(ec) && ec.elements.length > 0 && ec.elements.every(e => e.isTypeOnly)
  }
  const clause = decl.importClause
  if (!clause) return false                       // a bare `import '…'` runs the module
  if (clause.isTypeOnly) return true
  if (clause.name) return false                   // a default import is a value
  const nb = clause.namedBindings
  return !!nb && is.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every(e => e.isTypeOnly)
}

/** The root-relative path a relative or aliased specifier names, without extension or a trailing /index; null for a
 *  package specifier. */
function pathOf(spec, file, root, aliases) {
  let target = null
  for (const [prefix, dir] of Object.entries(aliases)) {
    if (spec.startsWith(prefix)) { target = resolve(root, dir, spec.slice(prefix.length)); break }
  }
  if (!target && !isBare(spec)) target = resolve(dirname(file), spec)
  if (!target) return null
  return posix(relative(root, target)).replace(EXT, '').replace(/\/index$/, '')
}

/** The `modules` entry a specifier matches, or null. A package entry matches itself and its subpaths; a path entry
 *  matches a specifier resolving to it or to its index. */
function matchOf(spec, file, root, modules, aliases) {
  const path = pathOf(spec, file, root, aliases)
  for (const m of modules) {
    const entry = m.replace(EXT, '').replace(/\/index$/, '')
    if (path !== null ? path === entry : (spec === m || spec.startsWith(m + '/'))) return m
  }
  return null
}

/**
 * Every import of a ruled module in the given files, with its verdict.
 * @param {string} root
 * @param {string[]} files absolute paths
 * @param {{ rules: { name: string, modules: string[], allow: string[] }[], aliases?: Record<string, string>, pinned?: Iterable<string> | Record<string, string> | Map<string, string> }} opts
 * @returns {{ hits: { file: string, line: number, specifier: string, module: string, rule: string, verdict: 'allowed'|'pinned'|'refused' }[], stale: string[] }}
 */
export function importVerdicts(root, files, { rules, aliases = {}, pinned = [] }) {
  const pins = new Set(pinned instanceof Map ? pinned.keys() : Symbol.iterator in Object(pinned) ? pinned : Object.keys(pinned))
  const hits = []
  if (files.length) {
    const parsed = parseSources(root, files)
    try {
      for (const f of files) {
        const src = parsed.sources.get(f)
        const rel = posix(relative(root, f))
        const visit = n => {
          let spec = null, value = true
          if ((is.isImportDeclaration(n) || is.isExportDeclaration(n)) && n.moduleSpecifier && is.isStringLiteral(n.moduleSpecifier)) {
            spec = n.moduleSpecifier.text
            value = !typeOnly(n)
          } else if (is.isCallExpression(n) && n.arguments.length === 1 && is.isStringLiteral(n.arguments[0]) &&
            (n.expression.kind === SyntaxKind.ImportKeyword || (is.isIdentifier(n.expression) && n.expression.text === 'require'))) {
            spec = n.arguments[0].text              // import('…') and require('…') load the module whatever they keep
          }
          if (spec && value) {
            for (const r of rules) {
              const module = matchOf(spec, f, root, r.modules, aliases)
              if (!module) continue
              const verdict = r.allow.some(g => matchesGlob(rel, g)) ? 'allowed' : pins.has(`${rel}|${r.name}`) ? 'pinned' : 'refused'
              hits.push({ file: rel, line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, specifier: spec, module, rule: r.name, verdict })
            }
          }
          n.forEachChild(visit)
        }
        src.forEachChild(visit)
      }
    } finally {
      parsed.close()
    }
  }
  const used = new Set(hits.filter(h => h.verdict === 'pinned').map(h => `${h.file}|${h.rule}`))
  return { hits, stale: [...pins].filter(p => !used.has(p)) }
}
