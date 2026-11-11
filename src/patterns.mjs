// THE PATTERNS GATE: a ratchet over regular expressions.
//
// Some constructs a project has decided to retire — a hand-rolled role check, a deprecated helper — are easiest to
// name as text. Refusing them all on the day the decision is made refuses nothing in practice, so this counts and
// holds: per rule and per file, the lines matching any of the rule's expressions. The counts may only fall (the
// ratchet in ratchet.mjs). At a baseline of zero the ratchet is a ban.
//
// It reads text, not the syntax tree: a matching line in a comment counts too.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Per file (relative paths in, the same keys out): the number of lines matching any expression, and those lines.
 * @param {string} root
 * @param {string[]} files relative paths
 * @param {(string|RegExp)[]} match
 * @returns {{ counts: Record<string, number>, lines: Record<string, number[]> }}
 */
export function countPatterns(root, files, match) {
  // Without the g and y flags: they carry lastIndex from one line to the next, and a line would be missed.
  const rx = match.map(m => m instanceof RegExp ? new RegExp(m.source, m.flags.replace(/[gy]/g, '')) : new RegExp(m))
  const counts = {}, lines = {}
  for (const f of files) {
    const hit = []
    readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (rx.some(r => r.test(line))) hit.push(i + 1)
    })
    counts[f] = hit.length
    if (hit.length) lines[f] = hit
  }
  return { counts, lines }
}
