// main.ts is mend, the CLI SPEC.md specifies (MIT starter, completed here). It does sections 1 to 10 of SPEC.md:
// the command line, output and exit codes, safe paths, format detection, three-tier line matching (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and the all-or-nothing write with move reporting (section 10). Node 22+, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old, new]. Used to report `R old -> new` lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Files (SPEC section 3)                                              */
/* ------------------------------------------------------------------ */

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC section 5)                                     */
/* ------------------------------------------------------------------ */

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** 0-based positions where o occurs in lines at the given tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!matchLine(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; only 0 when strict) at which o occurs, with its positions, or null. */
function firstTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of an old/new side: its text, and whether it is a context line. */
interface ML {
  text: string;
  ctx: boolean;
}

function reindentLine(text: string, f: string, p: string): string {
  if (text === '' || text.trim() === '') return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/**
 * The lines that replace O at position pos in fileLines, at the tier O was found at. Context lines are
 * written as the file's own matched lines; at tier 2 the other lines are re-indented (section 5).
 */
function buildReplacement(fileLines: string[], pos: number, o: ML[], n: ML[], tier: number): string[] {
  const ctxSrc: string[] = [];
  o.forEach((x, i) => {
    if (x.ctx) ctxSrc.push(fileLines[pos + i]!);
  });
  let ci = 0;
  const f = tier === 2 && o.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]!.text) : '';
  return n.map((x) => {
    if (x.ctx) return ctxSrc[ci++]!;
    return tier === 2 ? reindentLine(x.text, f, p) : x.text;
  });
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface HunkItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
}

interface Hunk {
  a: number;
  items: HunkItem[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** Path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function uniPath(line: string): string {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function hunkO(h: Hunk): ML[] {
  return h.items.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => ({ text: it.text, ctx: it.kind === 'ctx' }));
}

function hunkN(h: Hunk): ML[] {
  return h.items.filter((it) => it.kind === 'ctx' || it.kind === 'new').map((it) => ({ text: it.text, ctx: it.kind === 'ctx' }));
}

/** Last context or `+` item of a hunk, for the final-break rule. */
function lastCtxOrPlus(h: Hunk): HunkItem | null {
  for (let i = h.items.length - 1; i >= 0; i -= 1) {
    const it = h.items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it;
  }
  return null;
}

/** A hunk's body starting at lines[start]; trailing empty context lines are not part of it. */
function collectHunkBody(lines: string[], start: number): { items: HunkItem[]; next: number } {
  const items: HunkItem[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.noNl = true;
      j += 1;
    } else if (l === '') {
      items.push({ kind: 'ctx', text: '', noNl: false });
      j += 1;
    } else if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      items.push({ kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l.slice(1), noNl: false });
      j += 1;
    } else break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return { items, next: j };
}

function applyUniHunk(f: FileText, h: Hunk, d: number, strict: boolean, path: string): FileText {
  const o = hunkO(h);
  const n = hunkN(h);
  const lines = f.lines;
  if (o.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), lines.length);
    const out = [...lines.slice(0, pos), ...n.map((x) => x.text), ...lines.slice(pos)];
    let fin = f.final;
    if (pos === lines.length) {
      const last = lastCtxOrPlus(h);
      fin = last === null ? true : !last.noNl;
    }
    return { lines: out, br: f.br, final: fin };
  }
  const found = firstTier(lines, o.map((x) => x.text), strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const rep = buildReplacement(lines, best, o, n, found.tier);
  const out = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
  let fin = f.final;
  if (best + o.length === lines.length) {
    const last = lastCtxOrPlus(h);
    fin = last === null ? true : !last.noNl;
  }
  return { lines: out, br: f.br, final: fin };
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.pairOld !== null ? sec.pairOld : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== null ? sec.pairNew : sec.renameTo !== null ? sec.renameTo : sec.diffNew;
  const oldPath = oldP === null ? '' : oldP;
  const newPath = newP === null ? '' : newP;
  const create = oldPath === '/dev/null' || sec.createFlag;
  const del = newPath === '/dev/null' || sec.deleteFlag;
  if (create) {
    return (tree) => {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastNoNl = false;
      let has = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            has = true;
            lastNoNl = it.noNl;
          }
        }
      }
      tree.now.set(newPath, !has ? '' : plus.join('\n') + (lastNoNl ? '' : '\n'));
    };
  }
  if (del) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  const move = oldPath !== newPath;
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (move && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let f = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyUniHunk(f, h, d, strict, oldPath);
      d += hunkN(h).length - hunkO(h).length;
    }
    const out = serializeFile(f);
    if (move) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const fresh = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    createFlag: false,
    deleteFlag: false,
    hunks: [],
  });
  let cur: UniSection | null = null;
  let seenHunk = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const n = i + 1;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      seenHunk = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || seenHunk) {
        cur = fresh();
        sections.push(cur);
        seenHunk = false;
      }
      if (cur.pairOld === null) {
        cur.pairOld = uniPath(l);
        cur.pairNew = uniPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !seenHunk) throw new Exit2(`error: parse ${n + 1}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      if (cur === null) throw new Exit2(`error: parse ${n}`);
      const body = collectHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), items: body.items });
      seenHunk = true;
      i = body.next;
      continue;
    }
    if (cur !== null && !seenHunk) {
      if (l.startsWith('+++ ')) {
        if (cur.pairNew === null) cur.pairNew = uniPath(l);
      } else if (l.startsWith('rename from ')) {
        if (cur.renameFrom === null) cur.renameFrom = l.slice(12).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur.renameTo === null) cur.renameTo = l.slice(10).trim();
      } else if (l.startsWith('new file mode')) {
        cur.createFlag = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.deleteFlag = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => uniEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let boundary = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= boundary; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    boundary = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = parseFile(before);
    const found = firstTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const o: ML[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
    const n: ML[] = b.newLines.map((t) => ({ text: t, ctx: false }));
    const rep = buildReplacement(f.lines, pos, o, n, found.tier);
    const out = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + o.length)];
    tree.now.set(b.path, serializeFile({ lines: out, br: f.br, final: f.final }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function isSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function v4AddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4DeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** A chunk's body lines split into old lines O and new lines N. */
function v4ChunkON(c: V4Chunk): { o: ML[]; n: ML[] } {
  const o: ML[] = [];
  const n: ML[] = [];
  for (const raw of c.body) {
    if (raw.startsWith(' ')) {
      const t = raw.slice(1);
      o.push({ text: t, ctx: true });
      n.push({ text: t, ctx: true });
    } else if (raw.startsWith('-')) {
      o.push({ text: raw.slice(1), ctx: false });
    } else if (raw.startsWith('+')) {
      n.push({ text: raw.slice(1), ctx: false });
    } else {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true });
    }
  }
  return { o, n };
}

function v4UpdateEdit(path: string, moveTo: string | null, chunks: V4Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const c of chunks) {
      const { o, n } = v4ChunkON(c);
      if (c.anchor !== null) {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (matchLine(f.lines[k]!, c.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (o.length === 0) {
        const pos = c.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const ins = n.map((x) => x.text);
        f = { lines: [...f.lines.slice(0, pos), ...ins, ...f.lines.slice(pos)], br: f.br, final: f.final };
        cursor = pos + ins.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      const oText = o.map((x) => x.text);
      for (const t of tiers) {
        const occ = occurrences(f.lines, oText, t).filter((p) => p >= cursor && (!c.eof || p + o.length === f.lines.length));
        if (occ.length > 0) {
          found = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const rep = buildReplacement(f.lines, found.pos, o, n, found.tier);
      f = { lines: [...f.lines.slice(0, found.pos), ...rep, ...f.lines.slice(found.pos + o.length)], br: f.br, final: f.final };
      cursor = found.pos + n.length;
    }
    const out = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        const x = lines[j]!;
        if (x.startsWith('+') || blank(x)) raw.push(x);
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines = raw.map((x) => (x.startsWith('+') ? x.slice(1) : ''));
      edits.push(v4AddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (blank(lines[j]!)) {
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4DeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice(13).trim();
        j += 1;
      }
      const chunks: V4Chunk[] = [];
      let cur: V4Chunk | null = null;
      while (j < last && !isSectionStart(lines[j]!)) {
        const x = lines[j]!;
        if (x === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          j += 1;
          continue;
        }
        if (x.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = x.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          j += 1;
          continue;
        }
        if (blank(x) && cur === null && chunks.length > 0) {
          // A blank line after a closed chunk and before the next chunk: a separator, not content.
          j += 1;
          continue;
        }
        if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+') || blank(x)) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(x);
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) {
        while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!)) cur.body.pop();
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4UpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC sections 1, 2, 10)                                     */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const handled = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    if (wasOld !== null && wasNew === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      handled.add(oldP);
      handled.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
