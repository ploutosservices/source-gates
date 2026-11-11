#!/usr/bin/env python3
"""The Python half of the addresses gate: every string constant of the .py files under a directory.

Python's `ast` is in the standard library, so string literals are reached the way TypeScript's are:
comments never reach here, and every string carries the syntactic parent that says whether it is an
address or a look-alike. The JavaScript side judges these strings with the same rules it applies to
TypeScript, so there is one set of rules, not two.

  py-strings.py --strings <dir>   every string constant: file, line, text, context; and the files Python could
                                  not parse (JSON: {"strings": [...], "unparsed": [...]})
  py-strings.py --urls <dir>      URL-shaped text in .py files (parsed) and in .sh/.yml files (as text,
                                  labelled so: a text match cannot tell a comment from a link)
"""
import ast, json, os, re, sys

URLISH = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s'\"`)<>\\]+", re.I)
SKIP_DIRS = {"node_modules", ".git", "dist", ".next", "__pycache__", ".venv", "venv"}


def walk(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
        for f in files:
            yield os.path.join(d, f)


def parents(tree):
    out = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            out[child] = node
    return out


def context(node, pmap):
    p = pmap.get(node)
    if isinstance(p, ast.Assign) and p.targets:
        t = p.targets[0]
        return "assign:" + (t.id if isinstance(t, ast.Name) else ast.unparse(t)[:40])
    if isinstance(p, ast.keyword):
        return "kwarg:" + str(p.arg)
    if isinstance(p, ast.Call):
        return "call:" + ast.unparse(p.func)[:40]
    if isinstance(p, ast.Expr):
        return "docstring-or-bare-string"
    return type(p).__name__ if p else ""


UNPARSED = []


def strings_py(path):
    try:
        src = open(path, encoding="utf-8", errors="replace").read()
        tree = ast.parse(src)
    except (SyntaxError, ValueError) as e:
        # A gate that skips what it cannot read passes it: in --strings mode the file is reported in "unparsed" and the
        # caller decides; in --urls mode (a report, never a gate) an unparseable file contributes nothing.
        UNPARSED.append({"file": path, "error": str(e)})
        return []
    pmap, out = parents(tree), []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append({"file": path, "line": node.lineno, "text": node.value, "ctx": context(node, pmap)})
    return out


def urls_text(path):
    hits = []
    try:
        for i, line in enumerate(open(path, encoding="utf-8", errors="replace"), 1):
            for m in URLISH.finditer(line):
                hits.append({"file": path, "line": i, "url": m.group(0),
                             "ctx": "", "how": "text: cannot tell a comment from a link"})
    except OSError:
        pass
    return hits


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--strings":
        strings = [s for f in walk(sys.argv[2]) if f.endswith(".py") for s in strings_py(f)]
        json.dump({"strings": strings, "unparsed": UNPARSED}, sys.stdout)
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == "--urls":
        out = []
        for f in walk(sys.argv[2]):
            if f.endswith(".py"):
                out += [{"file": s["file"], "line": s["line"], "url": m.group(0), "ctx": s["ctx"], "how": "parsed"}
                        for s in strings_py(f) for m in URLISH.finditer(s["text"])]
            elif f.endswith((".sh", ".bash", ".yml", ".yaml")):
                out += urls_text(f)
        json.dump(out, sys.stdout)
        sys.exit(0)
    print("usage: py-strings.py --strings <dir> | --urls <dir>", file=sys.stderr)
    sys.exit(2)
