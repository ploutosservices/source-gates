// THE ENV GATE: which environment variables the code reads, and whether each is declared.
//
// The scan parses rather than regexing source text, which avoids two failure modes: a regex reads prose (an example
// in a comment becomes a variable), and a computed fallback read as "no default" makes a healthy deployment look
// broken. A default here is the literal where the read carries one, and '<computed>' where the code has a fallback
// whose value exists only at runtime: the existence of a fallback is the fact that matters.
import { join, relative } from 'node:path'
import { parseSources, is, isStringLiteralLike, SyntaxKind } from './parse.mjs'
import { filesUnder, isSourceFile, skipCommon, DEFAULT_TEST_FILE } from './files.mjs'

export const DEFAULT_IGNORE = ['NODE_ENV', 'NEXT_RUNTIME']

/**
 * @typedef {{ file: string, default?: string|number, guarded?: boolean, bare?: boolean, moduleScope?: boolean }} CodeVar
 * `moduleScope`: read outside every function somewhere, so it runs on import — a deployment without the value cannot
 * even load that file. Never set from a test file.
 */

/**
 * A variable is REQUIRED when the code reads it bare somewhere — no fallback anywhere — and never tolerates its
 * absence. Tolerant reads: a guard (`X && …`, `if (X)`, `X ? … : …`, `!X`) and a comparison (`X === 'true'`). A
 * variable tolerated in one file and hard-required in another reads optional.
 * @param {CodeVar} v
 */
export const isRequired = v => !!v.bare && !v.guarded && v.default === undefined

function atModuleScope(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (is.isFunctionDeclaration(p) || is.isArrowFunction(p) || is.isFunctionExpression(p) || is.isMethodDeclaration(p) ||
        is.isGetAccessorDeclaration(p) || is.isSetAccessorDeclaration(p) || is.isConstructorDeclaration(p) ||
        is.isClassStaticBlockDeclaration(p) || is.isPropertyDeclaration(p)) return false
  }
  return true
}

/** `helper('X')` for a helper named in `helpers` → X. Such a helper throws when the value is absent: a bare read. */
function helperName(node, helpers) {
  if (!helpers.size || !is.isCallExpression(node)) return undefined
  const fn = node.expression
  const called = is.isIdentifier(fn) ? fn.text : is.isPropertyAccessExpression(fn) ? fn.name.text : undefined
  if (!called || !helpers.has(called)) return undefined
  const [arg] = node.arguments
  return arg && isStringLiteralLike(arg) ? arg.text : undefined
}

/** `process.env.X` / `process.env['X']` → X. */
function envName(node) {
  const isProcessEnv = e => is.isPropertyAccessExpression(e) && e.expression.getText() === 'process' && e.name.text === 'env'
  if (is.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) return node.name.text
  if (is.isElementAccessExpression(node) && isProcessEnv(node.expression) && isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return undefined
}

/** The fallback the read carries: `?? lit` / `|| lit` → the literal; `?? <anything else>` / `|| <anything else>` → '<computed>'. */
function fallbackOf(node) {
  const parent = node.parent
  if (!parent || !is.isBinaryExpression(parent) || parent.left !== node) return undefined
  const op = parent.operatorToken.kind
  if (op !== SyntaxKind.QuestionQuestionToken && op !== SyntaxKind.BarBarToken) return undefined
  const rhs = parent.right
  if (isStringLiteralLike(rhs)) return rhs.text
  if (is.isNumericLiteral(rhs)) return Number(rhs.text)
  return '<computed>'
}

/** An existence check: either operand of `&&`, a strict comparison, the right of `??`, `if (X)`, `X ? :`, `!X`. */
function isGuard(node) {
  const parent = node.parent
  if (!parent) return false
  if (is.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind
    // Either operand of `&&`: one condition guards every value in it.
    if (op === SyntaxKind.AmpersandAmpersandToken) return true
    if (op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsEqualsToken) return true
    // The right of `??` is reached only when the left was absent: a link in a fallback chain, decided by its tail.
    if (parent.right === node && op === SyntaxKind.QuestionQuestionToken) return true
  }
  if (is.isIfStatement(parent) && parent.expression === node) return true
  if (is.isConditionalExpression(parent) && parent.condition === node) return true
  if (is.isPrefixUnaryExpression(parent) && parent.operator === SyntaxKind.ExclamationToken) return true
  return false
}

/**
 * Every variable the given files (absolute paths) read, with its fallback, guard and scope.
 * @param {string} root
 * @param {string[]} files
 * @param {{ requiredHelpers?: Iterable<string>, testFile?: RegExp }} [opts]
 * @returns {Map<string, CodeVar>}
 */
export function codeVarsOfFiles(root, files, { requiredHelpers = [], testFile = DEFAULT_TEST_FILE } = {}) {
  const helpers = new Set(requiredHelpers)
  const isTestFile = p => testFile.test(p)
  const found = new Map()
  const rel = p => relative(root, p).split('\\').join('/')
  if (!files.length) return found
  const parsed = parseSources(root, files)
  try {
    for (const path of files) {
      const visit = node => {
        const req = helperName(node, helpers)
        if (req) {
          const entry = found.get(req) ?? { file: rel(path) }
          entry.bare = true
          found.set(req, entry)
        }
        const name = envName(node)
        if (name) {
          const entry = found.get(name) ?? { file: rel(path) }
          const fb = fallbackOf(node)
          const guard = isGuard(node)
          if (entry.default === undefined && fb !== undefined) entry.default = fb
          if (guard) entry.guarded = true
          else if (fb === undefined) entry.bare = true
          // A test reading a value at module scope (to save and restore it) says nothing about what a deployment must
          // hold; only this flag ignores tests, the others see every file.
          if (fb === undefined && !guard && atModuleScope(node) && !isTestFile(path)) entry.moduleScope = true
          found.set(name, entry)
        }
        node.forEachChild(visit)
      }
      visit(parsed.sources.get(path))
    }
  } finally {
    parsed.close()
  }
  return found
}

/**
 * The same scan over directories (relative to root). An absent directory is tolerated, so a shared list fits a
 * project that lacks one — but not every one of them: a scan that read nothing would answer "0 variables" and pass on
 * nothing. Any other failure, a parser's included, is thrown.
 * @param {string} root
 * @param {string[]} dirs
 * @param {{ requiredHelpers?: Iterable<string>, testFile?: RegExp }} [opts]
 */
export function codeVars(root, dirs, opts = {}) {
  const files = []
  let found = 0
  for (const d of dirs) {
    try {
      files.push(...filesUnder(join(root, d), { skip: skipCommon, keep: isSourceFile }))
      found++
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
  if (dirs.length && !found) {
    throw Object.assign(new Error(`none of the directories to scan exists: ${dirs.join(', ')}`), { exitCode: 2 })
  }
  return codeVarsOfFiles(root, files, opts)
}

/**
 * Judge a scan against the declarations. A declaration with `warnUnused: false` is one a framework or a tool reads,
 * not the scanned code, so its absence from the scan is no warning.
 * @param {Map<string, CodeVar>} code
 * @param {{ declared: { name: string, warnUnused?: boolean }[], ignore?: Iterable<string> }} lists
 * @returns {{ undeclared: { name: string, file: string }[], unused: string[] }}
 */
export function judgeEnv(code, { declared, ignore = DEFAULT_IGNORE }) {
  const names = new Set(declared.map(d => d.name))
  const skip = new Set(ignore)
  const undeclared = [...code].filter(([v]) => !skip.has(v) && !names.has(v)).map(([name, v]) => ({ name, file: v.file }))
  const unused = [...new Set(declared.filter(d => d.warnUnused !== false && !code.has(d.name)).map(d => d.name))]
  return { undeclared, unused }
}
