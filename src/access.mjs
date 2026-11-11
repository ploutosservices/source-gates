// THE ACCESS GATE: every entry of a Next.js App Router project checks a permission, or says why it does not.
//
// Under role-based access control (ANSI INCITS 359-2004) a person's permissions are exactly the union of the bundles
// of the roles they hold, and every operation checks one. This gate keeps the second half true, reading the parsed
// tree (a comment is never a hit).
//
// An ENTRY is a `page`, a `route` handler, or a `'use server'` file under the app directory. It passes when:
//   · its own code checks — anywhere in the file, which passes every function in it;
//   · a checking `layout` above it covers it — pages only: a route handler and a server action are HTTP endpoints that
//     run without rendering a layout, so the layout's check never runs for them;
//   · the configured `extraAnswer({ file, root, sources })` returns a reason for it; or
//   · it is DECLARED, with its reason. That list is the whole of what checks nothing on purpose.
//
// CHECKING. A REFUSER refuses by itself, so any call to it counts. A QUESTION answers yes or no, and counts where an
// `if` that tests its result — directly, or through a variable assigned from it — has a then-branch that returns,
// throws, or calls notFound, forbidden, unauthorized, redirect or permanentRedirect. This is a heuristic: any return
// in that branch counts, a refusal in an `else` branch is not seen, and variables are matched by name within the file.
// A check that only decides whether a link shows does not make its page check.
//
// GUARDS are functions defined elsewhere that check; each one's own body must call the primitive or another guard, so
// a name cannot be listed to launder an entry. PINNED lists known unchecked entries to fix over time; a pin on an
// entry that checks, or that no longer exists, fails.
//
// FORBIDDEN NAMES are identifiers (a privileged flag, say, or a column that must decide nothing) that may appear only
// in the listed files; any other use is a finding, and so is a listed file that no longer uses the name.
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseSources, is, SyntaxKind } from './parse.mjs'
import { filesUnder, isSourceFile, skipCommon, DEFAULT_TEST_FILE } from './files.mjs'

/** A file whose directive prologue holds 'use server' (comments before it are allowed, as in JavaScript itself). */
function isServerActionFile(src) {
  for (const s of src.statements) {
    if (!is.isExpressionStatement(s) || !is.isStringLiteral(s.expression)) return false
    if (s.expression.text === 'use server') return true
  }
  return false
}

/** The app directory: `src/app` when it exists, else `app`. */
export function defaultAppDir(root) {
  return existsSync(join(root, 'src', 'app')) ? 'src/app' : 'app'
}

/**
 * The files the gate reads — the entries and the guards' files: every source file under each `include` directory
 * (default: the directory holding the app directory, or the root when the app directory is top-level), tests excluded.
 * @param {string} root
 * @param {string} [appDir]
 * @param {{ include?: string[], testFile?: RegExp }} [opts]
 */
export function accessFiles(root, appDir = defaultAppDir(root), { include, testFile = DEFAULT_TEST_FILE } = {}) {
  const dirs = include ?? [appDir.includes('/') ? appDir.slice(0, appDir.lastIndexOf('/')) : '.']
  return [...new Set(dirs.flatMap(d => filesUnder(join(root, d), {
    skip: skipCommon,
    keep: n => isSourceFile(n) && !testFile.test(n),
  })))].sort()
}

function isEntry(rel, isAction, appDir) {
  if (!rel.startsWith(`${appDir}/`)) return false
  const base = rel.split('/').pop()
  if (/^page\.(tsx|ts|jsx|js)$/.test(base) || /^route\.(ts|tsx|js)$/.test(base)) return true
  return isAction
}

const REFUSING_CALLS = new Set(['notFound', 'forbidden', 'redirect', 'unauthorized', 'permanentRedirect'])
const isFunctionLike = n => is.isFunctionDeclaration(n) || is.isFunctionExpression(n) || is.isArrowFunction(n) || is.isMethodDeclaration(n)
const calleeName = e => is.isIdentifier(e) ? e.text : is.isPropertyAccessExpression(e) ? e.name.text : null

/** Does this statement refuse — return, throw, or call a refusing function — without entering a nested function? */
function refuses(stmt) {
  let found = false
  const visit = n => {
    if (found || isFunctionLike(n)) return
    if (is.isReturnStatement(n) || is.isThrowStatement(n)) { found = true; return }
    if (is.isCallExpression(n) && is.isIdentifier(n.expression) && REFUSING_CALLS.has(n.expression.text)) { found = true; return }
    n.forEachChild(visit)
  }
  visit(stmt)
  return found
}

function contains(outer, inner) {
  for (let n = inner; n; n = n.parent) if (n === outer) return true
  return false
}

function boundNames(name, out = []) {
  if (is.isIdentifier(name)) out.push(name.text)
  else if (is.isArrayBindingPattern(name) || is.isObjectBindingPattern(name)) {
    for (const el of name.elements) if (el && !is.isOmittedExpression(el)) boundNames(el.name, out)
  }
  return out
}

/** Does this file check: call a refuser, or hang a refusal on a question's answer (directly, or through a variable)? */
function checksIn(src, guards) {
  const questions = [], ifs = []
  let refuser = false
  const visit = n => {
    if (is.isCallExpression(n)) {
      const g = guards.get(calleeName(n.expression))
      if (g?.refuses) refuser = true
      else if (g) questions.push(n)
    }
    if (is.isIfStatement(n)) ifs.push(n)
    n.forEachChild(visit)
  }
  src.forEachChild(visit)
  if (refuser) return true
  const tainted = new Set()
  for (const q of questions) {
    for (let n = q.parent; n && !isFunctionLike(n); n = n.parent) {
      if (is.isIfStatement(n)) { if (contains(n.expression, q) && refuses(n.thenStatement)) return true; break }
      if (is.isVariableDeclaration(n)) { boundNames(n.name).forEach(x => tainted.add(x)); break }
      if (is.isBinaryExpression(n) && n.operatorToken.kind === SyntaxKind.BarBarToken && is.isVariableDeclaration(n.parent)) continue
    }
  }
  if (!tainted.size) return false
  for (const i of ifs) {
    let mentions = false
    const look = n => { if (mentions) return; if (is.isIdentifier(n) && tainted.has(n.text)) mentions = true; else n.forEachChild(look) }
    look(i.expression)
    if (mentions && refuses(i.thenStatement)) return true
  }
  return false
}

function functionNamed(src, name) {
  let found = null
  const visit = n => {
    if (found) return
    if (is.isFunctionDeclaration(n) && n.name?.text === name) { found = n; return }
    if (is.isVariableDeclaration(n) && is.isIdentifier(n.name) && n.name.text === name && n.initializer && isFunctionLike(n.initializer)) { found = n.initializer; return }
    n.forEachChild(visit)
  }
  src.forEachChild(visit)
  return found
}

function callsAny(node, names) {
  let hit = false
  const visit = n => {
    if (hit) return
    if (is.isCallExpression(n) && names.has(calleeName(n.expression))) { hit = true; return }
    n.forEachChild(visit)
  }
  visit(node)
  return hit
}

function namesWithLines(src, wanted) {
  const hits = []
  const visit = n => {
    const text = is.isIdentifier(n) ? n.text : is.isStringLiteral(n) ? n.text : null
    if (text && wanted.has(text)) hits.push({ name: text, line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1 })
    n.forEachChild(visit)
  }
  src.forEachChild(visit)
  return [...new Map(hits.map(h => [h.line, h])).values()]
}

/** A Map or a plain object, as [key, value] pairs. A list or a Set has no values to read, so it is refused. */
function entriesOf(x, key) {
  if (x === undefined || x === null) return []
  if (x instanceof Map) return [...x]
  if (Array.isArray(x) || x instanceof Set) {
    throw Object.assign(new Error(`access.${key} must be a Map or a plain object (name → value), not a list`), { exitCode: 2 })
  }
  return Object.entries(x)
}

/**
 * The gate's verdicts for a tree.
 * @param {string} root
 * @param {string[]} files absolute paths (accessFiles(root, appDir))
 * @param {{
 *   appDir?: string,
 *   primitive: string,
 *   guards: Map<string, { file: string, refuses: boolean }> | Record<string, { file: string, refuses: boolean }>,
 *   declared?: Map<string, string> | Record<string, string>,
 *   pinned?: Map<string, string> | Record<string, string>,
 *   forbiddenNames?: Map<string, string[]> | Record<string, string[]>,
 *   extraAnswer?: (arg: { file: string, root: string, sources: Map<string, object> }) => ({ reason: string, names?: string[] } | null),
 * }} config
 */
export function accessVerdicts(root, files, config) {
  const appDir = config.appDir ?? defaultAppDir(root)
  const guards = new Map(entriesOf(config.guards, 'guards'))
  const declared = new Map(entriesOf(config.declared, 'declared'))
  const pinned = new Map(entriesOf(config.pinned, 'pinned'))
  const forbidden = new Map(entriesOf(config.forbiddenNames, 'forbiddenNames'))
  if (!existsSync(join(root, appDir))) {
    throw Object.assign(new Error(`no app directory at ${appDir}: a gate that reads nothing would pass on nothing`), { exitCode: 2 })
  }
  const primitive = config.primitive
  if (!guards.has(primitive)) guards.set(primitive, { file: null, refuses: false })
  const rel = f => relative(root, f).split(sep).join('/')
  const parsed = parseSources(root, files)
  try {
    const texts = new Map(), checking = new Map(), actions = new Set()
    for (const f of files) {
      texts.set(rel(f), readFileSync(f, 'utf8'))
      checking.set(rel(f), checksIn(parsed.sources.get(f), guards))
      if (isServerActionFile(parsed.sources.get(f))) actions.add(rel(f))
    }

    const problems = []
    for (const [name, { file }] of guards) {
      if (name === primitive) continue
      const f = files.find(x => rel(x) === file)
      const fn = f && functionNamed(parsed.sources.get(f), name)
      if (!fn) problems.push(`guard ${name}: no function by that name in ${file}`)
      else if (!callsAny(fn, new Set([...guards.keys()].filter(k => k !== name)))) problems.push(`guard ${name}: ${file} — its body calls neither ${primitive}() nor another guard`)
    }
    const checksItself = r => checking.get(r) === true

    const coveringLayouts = [...texts.keys()].filter(r => /\/layout\.(tsx|ts|jsx|js)$/.test(r) && r.startsWith(`${appDir}/`) && checksItself(r))
    const coveredBy = r => coveringLayouts.find(l => r.startsWith(l.slice(0, l.lastIndexOf('/') + 1)))

    const entries = [], silent = []
    for (const r of texts.keys()) {
      if (!isEntry(r, actions.has(r), appDir)) continue
      // A layout renders around pages only: a route handler and a server action are HTTP endpoints that run without it.
      const isPage = /\/page\.(tsx|ts|jsx|js)$/.test(r)
      const layout = isPage && !actions.has(r) ? coveredBy(r) : null
      const extra = config.extraAnswer ? config.extraAnswer({ file: join(root, r), root, sources: parsed.sources }) : null
      const own = checksItself(r) ? 'checks' : layout ? `layout ${layout}` : declared.has(r) ? `declared: ${declared.get(r)}` : null
      const how = own && extra ? `${own} · ${extra.reason}` : own ?? extra?.reason ?? null
      entries.push({ file: r, how, names: extra?.names ?? [] })
      if (!how && !pinned.has(r)) silent.push(r)
    }
    const entrySet = new Set(entries.map(e => e.file))
    const unusedPins = [...pinned.keys()].filter(p => !entrySet.has(p) || entries.find(e => e.file === p).how)
    const unusedDeclared = [...declared.keys()].filter(p => !entrySet.has(p) || checksItself(p))

    const forbiddenUses = [], unusedAllowances = []
    for (const [name, allowed] of forbidden) {
      const ok = new Set(allowed)
      for (const f of files) {
        const r = rel(f)
        if (ok.has(r)) continue
        for (const h of namesWithLines(parsed.sources.get(f), new Set([name]))) forbiddenUses.push(`${name}: ${r}:${h.line}`)
      }
      for (const p of ok) {
        const f = files.find(x => rel(x) === p)
        if (!f || !namesWithLines(parsed.sources.get(f), new Set([name])).length) unusedAllowances.push(`${name}: ${p}`)
      }
    }
    return { entries, silent, unusedPins, unusedDeclared, forbiddenUses, unusedAllowances, problems }
  } finally {
    parsed.close()
  }
}
