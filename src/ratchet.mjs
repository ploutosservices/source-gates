// THE RATCHET the counting gates share (literals, patterns): per file, a count that may only fall.
//
// A file's count must equal its baseline. Growth fails. A fall must be written into the baseline in the same change,
// so the gain is kept. A new file starts at zero. A baseline path that is gone fails, so a rename carries its count
// (through git's rename detection, when the baseline is written).
import { execFileSync } from 'node:child_process'

const plain = n => n

/**
 * Judge counts ({ file: count }) against a baseline ({ file: total }).
 * @param {Record<string, any>} counts
 * @param {Record<string, number>} baseline
 * @param {{ total?: (c: any) => number, describe?: (file: string, count: any, was: number) => string }} [how]
 * @returns {{ grew: string[], fell: string[], gone: string[] }}
 */
export function judgeRatchet(counts, baseline, { total = plain, describe } = {}) {
  const grew = [], fell = [], gone = []
  for (const [f, c] of Object.entries(counts)) {
    const was = baseline[f] ?? 0
    if (total(c) > was) grew.push(describe ? describe(f, c, was) : `${f}: ${total(c)}, baseline ${was}`)
    else if (total(c) < was) fell.push(`${f}: ${total(c)}, baseline ${was}`)
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
 * files whose count would rise, which a caller refuses (a baseline is never raised), unless `first` (no baseline yet).
 * @param {Record<string, any>} counts
 * @param {Record<string, number>} baseline
 * @param {Map<string, string>} [renames]
 * @param {{ total?: (c: any) => number, first?: boolean }} [how]
 */
export function nextRatchet(counts, baseline, renames = new Map(), { total = plain, first = false } = {}) {
  const next = {}, raised = []
  for (const [f, c] of Object.entries(counts)) {
    const was = baseline[f] ?? (renames.has(f) ? baseline[renames.get(f)] : undefined) ?? 0
    if (total(c) > was) raised.push(`${f}: ${total(c)}, baseline ${was}`)
    if (total(c) > 0) next[f] = total(c)
  }
  return { next, raised: first ? [] : raised }
}
