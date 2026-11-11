// THE LITERALS GATE: a ratchet on numbers and lists written into the files you name (pages, components).
//
// A business number — a fee, a cap, a cut-off — written into a page instead of read from one module is a decision
// hidden where nobody reviews it. Refusing every literal on day one refuses nothing in practice (most are layout, so
// they would all be pinned at once). So this counts and holds: per file, the numeric literals not in the allowed set
// (default 0, 1, 2) plus the array literals whose every element is a literal. A file's count must equal its baseline:
// growth fails; a fall must be written into the baseline in the same change, so the ratchet keeps what was gained; a
// new file starts at zero; a baseline path that is gone fails (a rename carries its count, through git).
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parseSources, is, SyntaxKind } from './parse.mjs'

const isLiteral = e => is.isStringLiteral(e) || is.isNumericLiteral(e) || is.isNoSubstitutionTemplateLiteral(e) ||
  (is.isPrefixUnaryExpression(e) && e.operator === SyntaxKind.MinusToken && is.isNumericLiteral(e.operand))

/**
 * Per file (relative paths in, the same keys out): { numbers, lists }.
 * @param {string} root
 * @param {string[]} files relative paths
 * @param {{ allowed?: Iterable<number> }} [opts]
 */
export function countLiterals(root, files, { allowed = [0, 1, 2] } = {}) {
  const ok = new Set([...allowed].map(Number))
  const out = {}
  if (!files.length) return out
  const abs = files.map(f => join(root, f))
  const parsed = parseSources(root, abs)
  try {
    files.forEach((f, i) => {
      let numbers = 0, lists = 0
      const visit = n => {
        if (is.isNumericLiteral(n) && !ok.has(Number(n.text.replace(/_/g, '')))) numbers++
        if (is.isArrayLiteralExpression(n) && n.elements.length > 0 && n.elements.every(isLiteral)) lists++
        n.forEachChild(visit)
      }
      parsed.sources.get(abs[i]).forEachChild(visit)
      out[f] = { numbers, lists }
    })
  } finally {
    parsed.close()
  }
  return out
}

export const totalOf = c => c.numbers + c.lists

/** Judge counts against a baseline ({ file: total }): growth, falls not written down, new files above zero, gone paths. */
export function judgeLiterals(counts, baseline) {
  const grew = [], fell = [], gone = []
  for (const [f, c] of Object.entries(counts)) {
    const was = baseline[f] ?? 0
    if (totalOf(c) > was) grew.push(`${f}: ${totalOf(c)} (${c.numbers} numbers, ${c.lists} lists), baseline ${was}`)
    else if (totalOf(c) < was) fell.push(`${f}: ${totalOf(c)}, baseline ${was}`)
  }
  for (const f of Object.keys(baseline)) if (!(f in counts)) gone.push(f)
  return { grew, fell, gone }
}

/** Staged and committed renames against HEAD (an untracked new path is not seen): new path → old path, relative to the
 *  repository's top level. Empty outside a git checkout. */
export function gitRenames(root) {
  try {
    const out = execFileSync('git', ['diff', '-M', '--name-status', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return new Map(out.split('\n').filter(l => l.startsWith('R')).map(l => { const [, from, to] = l.split('\t'); return [to, from] }))
  } catch { return new Map() }
}

/**
 * The next baseline from counts: every file above zero, a renamed file carrying its old path's count. Returns the
 * files whose count would rise, which a caller refuses (the baseline is never raised), unless the baseline is empty.
 */
export function nextBaseline(counts, baseline, renames = new Map()) {
  const next = {}, raised = []
  for (const [f, c] of Object.entries(counts)) {
    const was = baseline[f] ?? (renames.has(f) ? baseline[renames.get(f)] : undefined) ?? 0
    if (totalOf(c) > was) raised.push(`${f}: ${totalOf(c)}, baseline ${was}`)
    if (totalOf(c) > 0) next[f] = totalOf(c)
  }
  return { next, raised: Object.keys(baseline).length ? raised : [] }
}
