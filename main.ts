// main.ts is mend, the CLI SPEC.md specifies (version 1). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// This entry (v3) implements all of SPEC.md: the command line, output and exit codes, safe paths,
// format detection, JSON edits and the all-or-nothing write (sections 1-4, 9, 10), plus the three
// line-matching formats: unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A
// patches (section 8), over the three-tier line matching of section 5.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  /** Successful move edits, as (old, new) pairs, for the `R` output lines (section 2). */
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

/** A file's text split into lines per section 3: its break, its lines, whether it ends with a break. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Section 5: line equality at a tier. Tier 1 trims trailing spaces/tabs, tier 2 both sides. */
const trimT = (s: string): string => s.replace(/[ \t]+$/, '');
const trimB = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimT(a) === trimT(b);
  return trimB(a) === trimB(b);
}
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Positions i >= `from` where O occurs in F at `tier`; when `eofOnly`, only ones ending at F's last line. */
function occurrences(O: string[], F: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= F.length; i++) {
    if (eofOnly && i + O.length !== F.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k]!, F[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: 0 only) at which O occurs in F at/after `from`. */
function findTier(O: string[], F: string[], from: number, eofOnly: boolean, strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(O, F, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at/after `from` equal to a single-line anchor, at the first tier with one. */
function findTierSingle(anchor: string, F: string[], from: number, strict: boolean): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < F.length; i++) {
      if (lineEq(anchor, F[i]!, t)) return i;
    }
  }
  return null;
}

/** One line of N: `text`, and for a context line the index of its line in O (`ctx` >= 0), else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * Section 5: build the replacement lines for O found at `pos` in F at `tier`. A context line is
 * written as the file's own matched line; at tier 2 every other line is re-indented (P, the leading
 * spaces/tabs of O's first line, replaced by F, those of the file's first matched line); at tiers
 * 0 and 1 the lines are written as they are. O empty: no re-indentation (no matched lines).
 */
function buildReplacement(O: string[], N: NLine[], F: string[], pos: number, tier: number): string[] {
  const Fp = O.length > 0 ? leadingWS(F[pos]!) : '';
  const Pp = O.length > 0 ? leadingWS(O[0]!) : '';
  const out: string[] = [];
  for (const nl of N) {
    if (nl.ctx >= 0) {
      out.push(F[pos + nl.ctx]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(Pp)) out.push(Fp + t.slice(Pp.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

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

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
  oLines: string[];
  nLines: NLine[];
  plus: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinalBreak: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoBreak: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

/** Path from a `--- `/`+++ ` header line: after the four characters, up to the first tab, trimmed, leading a//b/ removed. `/dev/null` means no file. */
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[start]!);
  if (m === null) throw new Exit2(`error: parse ${start + 1}`);
  const a = Number(m[1]);
  let j = start + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (!isBodyLine(l)) break;
    body.push(l);
    j++;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const oLines: string[] = [];
  const nLines: NLine[] = [];
  const plus: string[] = [];
  for (const b of body) {
    if (b === '' || b.startsWith(' ')) {
      const t = b === '' ? '' : b.slice(1);
      oLines.push(t);
      nLines.push({ text: t, ctx: oLines.length - 1 });
    } else if (b.startsWith('-')) {
      oLines.push(b.slice(1));
    } else if (b.startsWith('+')) {
      const t = b.slice(1);
      plus.push(t);
      nLines.push({ text: t, ctx: -1 });
    }
  }
  let noFinalBreak = false;
  let lastPlusNoBreak = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b === '' || b.startsWith(' ') || b.startsWith('+')) {
      if (body[k + 1] !== undefined && body[k + 1]!.startsWith('\\')) noFinalBreak = true;
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.startsWith('+')) {
      if (body[k + 1] !== undefined && body[k + 1]!.startsWith('\\')) lastPlusNoBreak = true;
      break;
    }
  }
  return { hunk: { a, body, oLines, nLines, plus, noFinalBreak, lastPlusNoBreak }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  const push = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
    hasPair = false;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    const dg = l.startsWith('diff --git ') ? DIFF_GIT.exec(l) : null;
    if (l.startsWith('diff --git ')) {
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = { oldPath: dg[1]!, newPath: dg[2]!, isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      if (cur === null || !inHeader) {
        push();
        cur = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
        inHeader = true;
      } else {
        cur.oldPath = oldP;
        cur.newPath = newP;
      }
      hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (!hasPair && l.startsWith('rename from ')) cur.oldPath = l.slice('rename from '.length).trim();
      else if (!hasPair && l.startsWith('rename to ')) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  push();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to `text`; throws Fail('no-match', path) on a failing hunk. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.oLines.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const rep = h.nLines.map((nl) => nl.text);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...rep);
      if (atEnd) f.final = !h.noFinalBreak;
      d += h.nLines.length;
      continue;
    }
    const found = findTier(h.oLines, f.lines, 0, false, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const rep = buildReplacement(h.oLines, h.nLines, f.lines, best, found.tier);
    const reachesEOF = best + h.oLines.length === f.lines.length;
    f.lines.splice(best, h.oLines.length, ...rep);
    if (reachesEOF) f.final = !h.noFinalBreak;
    d += h.nLines.length - h.oLines.length;
  }
  return joinFile(f);
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    const isCreate = oldP === null || s.isCreate;
    const isDelete = newP === null || s.isDelete;
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plusLines: string[] = [];
      let lastPlusNoBreak = false;
      for (const h of s.hunks) {
        plusLines.push(...h.plus);
        if (h.plus.length > 0) lastPlusNoBreak = h.lastPlusNoBreak;
      }
      const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusNoBreak ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const result = applyHunks(tree.get(oldP!)!, s.hunks, strict, oldP!);
      tree.now.set(newP!, result);
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
    const result = applyHunks(tree.get(oldP!)!, s.hunks, strict, oldP!);
    tree.now.set(oldP!, result);
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, 0, false, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = buildReplacement(
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
      f.lines,
      pos,
      found.tier,
    );
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let gt = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, gt);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = gt;
    i = gt + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function chunkON(body: string[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b === '' || b.startsWith(' ')) {
      const t = b === '' ? '' : b.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
    } else if (b.startsWith('-')) {
      O.push(b.slice(1));
    } else if (b.startsWith('+')) {
      N.push({ text: b.slice(1), ctx: -1 });
    }
  }
  return { O, N };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findTierSingle(ch.anchor, f.lines, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = chunkON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const rep = N.map((nl) => nl.text);
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      } else {
        const found = findTier(O, f.lines, cursor, ch.eof, strict);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const rep = buildReplacement(O, N, f.lines, pos, found.tier);
        f.lines.splice(pos, O.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let spath: string;
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      spath = l.slice('*** Add File:'.length).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'delete';
      spath = l.slice('*** Delete File:'.length).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'update';
      spath = l.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i;
    const raw: Array<{ line: string; idx: number }> = [];
    let j = i + 1;
    while (j < last) {
      const lj = lines[j]!;
      if (lj.startsWith('*** Add File:') || lj.startsWith('*** Delete File:') || lj.startsWith('*** Update File:')) break;
      raw.push({ line: lj, idx: j });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.line.startsWith('+')) fileLines.push(r.line.slice(1));
        else if (r.line === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push(v4aAddEdit(spath, fileLines));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      edits.push(v4aDeleteEdit(spath));
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.line.startsWith('*** Move to:')) {
        moveTo = raw[0]!.line.slice('*** Move to:'.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let chunkCount = 0;
      const isBody = (s: string): boolean => s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+');
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const s = r.line;
        if (s.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: s.slice(2).trim(), eof: false, body: [] };
          chunkCount++;
        } else if (s === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (s.startsWith('*** Move to:')) {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        } else if (isBody(s)) {
          if (cur === null) {
            if (chunkCount > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunkCount++;
          }
          cur.body.push(s);
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine + 1}`);
      edits.push(v4aUpdateEdit(spath, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const entries: Row[] = [];
  const dSet = new Set<string>();
  const aSet = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) {
      entries.push({ key: p, line: `A ${p}` });
      aSet.add(p);
    } else if (now === null) {
      entries.push({ key: p, line: `D ${p}` });
      dSet.add(p);
    } else {
      entries.push({ key: p, line: `M ${p}` });
    }
  }
  for (const [oldP, newP] of tree.moves) {
    if (dSet.has(oldP) && aSet.has(newP)) {
      const di = entries.findIndex((e) => e.line === `D ${oldP}`);
      const ai = entries.findIndex((e) => e.line === `A ${newP}`);
      if (di >= 0) entries.splice(di, 1);
      if (ai >= 0) entries.splice(ai, 1);
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      dSet.delete(oldP);
      aSet.delete(newP);
    }
  }
  entries.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const rows = entries.map((e) => e.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
