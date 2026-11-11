// THE ICONS GATE: every icon a React tree renders says what it means on hover.
//
// An icon with no text label means nothing to a reader who does not already know it. A rule kept as a preference is
// applied unevenly; as a gate it holds for every icon, including the one written tomorrow.
//
// AN ICON is a JSX element whose tag's last name matches the pattern (default `Icon$`: <CheckIcon>, <Lucide.XIcon>).
// Icons passed as values (`icon={XIcon}`, a lookup table) are not matched: the place that renders them is.
//
// COVERED when a JSX ancestor in the same file is one of the wrappers (default <Tooltip>), or when the icon's component
// is defined in the scanned files with a wrapper in its own body: an icon component that labels itself is covered at
// every call site, which is the better shape: the label is written once, and every new call site inherits it.
//
// A `title` attribute does not count: it appears after a browser delay, in the browser's style, and never on touch.
import { relative } from 'node:path'
import { parseSources, is } from './parse.mjs'

/** The tag's name as written (`Tooltip`, `Lucide.XIcon`), or null for a fragment. */
function tagName(el) {
  const t = is.isJsxElement(el) ? el.openingElement.tagName : is.isJsxSelfClosingElement(el) ? el.tagName : null
  return t ? t.getText() : null
}
const lastName = name => name.split('.').pop()

/** The body a component name is defined with: `function Name`, or `const Name = …`. */
function definitions(src, pattern) {
  const out = []
  const visit = n => {
    if (is.isFunctionDeclaration(n) && n.name && pattern.test(n.name.text)) out.push({ name: n.name.text, body: n })
    else if (is.isVariableDeclaration(n) && is.isIdentifier(n.name) && pattern.test(n.name.text) && n.initializer) {
      out.push({ name: n.name.text, body: n.initializer })
    }
    n.forEachChild(visit)
  }
  src.forEachChild(visit)
  return out
}

function containsWrapper(node, wrappers) {
  let hit = false
  const visit = n => {
    if (hit) return
    const t = (is.isJsxElement(n) || is.isJsxSelfClosingElement(n)) ? tagName(n) : null
    if (t && wrappers.has(lastName(t))) { hit = true; return }
    n.forEachChild(visit)
  }
  visit(node)
  return hit
}

/**
 * @param {string} root
 * @param {string[]} files absolute paths of the files to scan (.tsx/.jsx)
 * @param {{ pattern?: RegExp|string, wrappers?: Iterable<string>, exempt?: Map<string,string>|Record<string,string> }} [config]
 * @returns {{ icons: number, bare: { file: string, line: number, tag: string }[], selfLabelled: string[], unusedExempt: string[] }}
 */
export function iconVerdicts(root, files, config = {}) {
  const pattern = config.pattern instanceof RegExp ? config.pattern : new RegExp(config.pattern ?? 'Icon$')
  const wrappers = new Set(config.wrappers ?? ['Tooltip'])
  const exempt = new Map(config.exempt instanceof Map ? config.exempt : Object.entries(config.exempt ?? {}))
  const rel = f => relative(root, f).split('\\').join('/')
  if (!files.length) return { icons: 0, bare: [], selfLabelled: [], unusedExempt: [...exempt.keys()] }
  const parsed = parseSources(root, files)
  try {
    const selfLabelled = new Set()
    for (const f of files) {
      for (const d of definitions(parsed.sources.get(f), pattern)) if (containsWrapper(d.body, wrappers)) selfLabelled.add(d.name)
    }
    let icons = 0
    const bare = [], rendering = new Set()
    for (const f of files) {
      const src = parsed.sources.get(f)
      const r = rel(f)
      const visit = (n, covered) => {
        const t = (is.isJsxElement(n) || is.isJsxSelfClosingElement(n)) ? tagName(n) : null
        if (t && pattern.test(lastName(t)) && !selfLabelled.has(lastName(t))) {
          rendering.add(r)
          if (!exempt.has(r)) {
            icons++
            if (!covered) bare.push({ file: r, line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, tag: t })
          }
        }
        const inside = covered || (t !== null && wrappers.has(lastName(t)))
        n.forEachChild(c => visit(c, inside))
      }
      src.forEachChild(c => visit(c, false))
    }
    const unusedExempt = [...exempt.keys()].filter(f => !rendering.has(f))
    return { icons, bare, selfLabelled: [...selfLabelled].sort(), unusedExempt }
  } finally {
    parsed.close()
  }
}
