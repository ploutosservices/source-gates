// THE LITERALS GATE: a ratchet on numbers and lists written into the files you name (pages, components).
//
// A business number — a fee, a cap, a cut-off — written into a page instead of read from one module is a decision
// hidden where nobody reviews it. Refusing every literal on day one refuses nothing in practice (most are layout, so
// they would all be pinned at once). So this counts and holds: per file, the numeric literals not in the allowed set
// (default 0, 1, 2) plus the array literals whose every element is a literal. A file's count must equal its baseline:
// growth fails; a fall must be written into the baseline in the same change, so the ratchet keeps what was gained; a
// new file starts at zero; a baseline path that is gone fails (a rename carries its count, through git).
import { join } from 'node:path'
import { parseSources, is, SyntaxKind } from './parse.mjs'
import { judgeRatchet, nextRatchet, gitRenames } from './ratchet.mjs'

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
export const judgeLiterals = (counts, baseline) => judgeRatchet(counts, baseline, {
  total: totalOf,
  describe: (f, c, was) => `${f}: ${totalOf(c)} (${c.numbers} numbers, ${c.lists} lists), baseline ${was}`,
})

export { gitRenames }

/**
 * The next baseline from counts: every file above zero, a renamed file carrying its old path's count. Returns the
 * files whose count would rise, which a caller refuses (the baseline is never raised), unless the baseline is empty.
 */
export const nextBaseline = (counts, baseline, renames = new Map()) =>
  nextRatchet(counts, baseline, renames, { total: totalOf, first: Object.keys(baseline).length === 0 })
