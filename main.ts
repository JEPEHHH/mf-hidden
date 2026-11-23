// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  finalNewline: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalNewline: false };
  const finalNewline = text.endsWith(br);
  const lines = text.split(br);
  if (finalNewline) lines.pop();
  return { lines, br, finalNewline };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalNewline ? f.br : '');
}

function leadWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function rtrimWs(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function trimWs(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a += 1;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
  return s.slice(a, b);
}

function normTier(s: string, tier: 0 | 1 | 2): string {
  if (tier === 0) return s;
  if (tier === 1) return rtrimWs(s);
  return trimWs(s);
}

interface MatchResult {
  tier: 0 | 1 | 2;
  positions: number[];
}

function findMatches(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  startIdx = 0,
  eofOnly = false,
): MatchResult | null {
  const k = oldLines.length;
  const maxTier: 0 | 1 | 2 = strict ? 0 : 2;
  const minPos = eofOnly ? fileLines.length - k : startIdx;
  const maxPos = fileLines.length - k;
  if (minPos < startIdx || minPos > maxPos) return null;
  for (let t = 0; t <= maxTier; t += 1) {
    const tier = t as 0 | 1 | 2;
    const normOld = oldLines.map((l) => normTier(l, tier));
    const positions: number[] = [];
    for (let i = minPos; i <= maxPos; i += 1) {
      let ok = true;
      for (let j = 0; j < k; j += 1) {
        if (normTier(fileLines[i + j]!, tier) !== normOld[j]!) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindentLine(line: string, pIndent: string, fIndent: string): string {
  if (blank(line)) return line;
  if (line.startsWith(pIndent)) return fIndent + line.slice(pIndent.length);
  return line;
}

interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

function buildReplacement(
  body: BodyLine[],
  fileLines: string[],
  matchPos: number,
  oldLines: string[],
  tier: 0 | 1 | 2,
): string[] {
  const pIndent = tier === 2 && oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  const fIndent = tier === 2 && oldLines.length > 0 ? leadWs(fileLines[matchPos]!) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const item of body) {
    if (item.kind === 'ctx') {
      out.push(fileLines[matchPos + oIdx]!);
      oIdx += 1;
    } else if (item.kind === 'del') {
      oIdx += 1;
    } else {
      out.push(tier === 2 ? reindentLine(item.text, pIndent, fIndent) : item.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  recordMove(from: string, to: string): void {
    this.moves.push([from, to]);
  }
}

type Edit = (tree: Tree) => void;

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

interface UnifiedHunk {
  oldStart: number;
  body: BodyLine[];
  noNewlineAfterNew: boolean;
  lastPlusNoNewline: boolean;
  hasPlus: boolean;
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UnifiedHunk[];
}

function parseDiffHeaderPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.replace(/^ +| +$/g, '');
  if (s === '/dev/null') return '/dev/null';
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function parseDiffGitLine(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;

  const startSection = (): UnifiedSection => {
    const s: UnifiedSection = {
      gitOld: null,
      gitNew: null,
      minusPath: null,
      plusPath: null,
      renameFrom: null,
      renameTo: null,
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGitLine(line)) {
      const [go, gn] = parseDiffGitLine(line, i + 1);
      const s = startSection();
      s.gitOld = go;
      s.gitNew = gn;
      i += 1;
      continue;
    }

    if (line.startsWith('--- ')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1]! : null;
      const nextIsPlus = nextLine !== null && nextLine.startsWith('+++ ');
      if (inHeader && cur !== null && cur.minusPath === null && cur.plusPath === null) {
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        cur.minusPath = parseDiffHeaderPath(line);
        cur.plusPath = parseDiffHeaderPath(nextLine!);
        i += 2;
        continue;
      }
      if (nextIsPlus) {
        const s = startSection();
        s.minusPath = parseDiffHeaderPath(line);
        s.plusPath = parseDiffHeaderPath(nextLine!);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).replace(/^ +| +$/g, '');
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).replace(/^ +| +$/g, '');
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFileMode = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
        i += 1;
        continue;
      }
    }

    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const oldStart = Number(m[1]!);
      i += 1;

      interface RawBodyItem {
        kind: 'ctx' | 'del' | 'add' | 'bs';
        text: string;
        wasEmpty: boolean;
      }
      const raw: RawBodyItem[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (isDiffGitLine(bl)) break;
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '') {
          raw.push({ kind: 'ctx', text: '', wasEmpty: true });
          i += 1;
        } else if (bl[0] === ' ') {
          raw.push({ kind: 'ctx', text: bl.slice(1), wasEmpty: false });
          i += 1;
        } else if (bl[0] === '-') {
          raw.push({ kind: 'del', text: bl.slice(1), wasEmpty: false });
          i += 1;
        } else if (bl[0] === '+') {
          raw.push({ kind: 'add', text: bl.slice(1), wasEmpty: false });
          i += 1;
        } else if (bl[0] === '\\') {
          raw.push({ kind: 'bs', text: bl, wasEmpty: false });
          i += 1;
        } else {
          break;
        }
      }
      while (raw.length > 0 && raw[raw.length - 1]!.wasEmpty) raw.pop();

      const body: BodyLine[] = [];
      let lastKind: 'ctx' | 'del' | 'add' | null = null;
      let noNewlineAfterNew = false;
      let lastPlusNoNewline = false;
      let hasPlus = false;
      for (const item of raw) {
        if (item.kind === 'bs') {
          if (lastKind === 'ctx' || lastKind === 'add') noNewlineAfterNew = true;
          if (lastKind === 'add') lastPlusNoNewline = true;
          lastKind = null;
        } else {
          body.push({ kind: item.kind, text: item.text });
          lastKind = item.kind;
          if (item.kind === 'ctx' || item.kind === 'add') noNewlineAfterNew = false;
          if (item.kind === 'add') {
            hasPlus = true;
            lastPlusNoNewline = false;
          }
        }
      }

      cur.hunks.push({ oldStart, body, noNewlineAfterNew, lastPlusNoNewline, hasPlus });
      continue;
    }

    i += 1;
  }

  const applyHunks = (file: FileLines, hunks: UnifiedHunk[], errPath: string): void => {
    let d = 0;
    for (const hunk of hunks) {
      const oldLines = hunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
      if (oldLines.length === 0) {
        const newLines = hunk.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const insPos = Math.max(0, Math.min(file.lines.length, hunk.oldStart + d));
        const atEnd = insPos === file.lines.length;
        file.lines.splice(insPos, 0, ...newLines);
        if (atEnd) file.finalNewline = !hunk.noNewlineAfterNew;
        d += newLines.length;
      } else {
        const match = findMatches(file.lines, oldLines, strict);
        if (match === null) throw new Fail('no-match', errPath);
        const target = hunk.oldStart - 1 + d;
        let bestPos = match.positions[0]!;
        let bestDist = Math.abs(bestPos - target);
        for (let k = 1; k < match.positions.length; k += 1) {
          const pos = match.positions[k]!;
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            bestDist = dist;
            bestPos = pos;
          }
        }
        const runsToEnd = bestPos + oldLines.length === file.lines.length;
        const replacement = buildReplacement(hunk.body, file.lines, bestPos, oldLines, match.tier);
        file.lines.splice(bestPos, oldLines.length, ...replacement);
        if (runsToEnd) file.finalNewline = !hunk.noNewlineAfterNew;
        d += replacement.length - oldLines.length;
      }
    }
  };

  return sections.map((sec): Edit => {
    const oldPath = sec.minusPath ?? sec.renameFrom ?? sec.gitOld ?? '';
    const newPath = sec.plusPath ?? sec.renameTo ?? sec.gitNew ?? '';
    const isCreate = oldPath === '/dev/null' || sec.newFileMode;
    const isDelete = !isCreate && (newPath === '/dev/null' || sec.deletedFileMode);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;

    if (isCreate) {
      return (tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const added: string[] = [];
        let lastPlusNoNewline = false;
        for (const h of sec.hunks) {
          for (const b of h.body) {
            if (b.kind === 'add') added.push(b.text);
          }
          if (h.hasPlus) lastPlusNoNewline = h.lastPlusNoNewline;
        }
        tree.now.set(newPath, joinFile({ lines: added, br: '\n', finalNewline: !lastPlusNoNewline }));
      };
    }

    if (isDelete) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }

    if (isMove) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        let out = before;
        if (sec.hunks.length > 0) {
          const file = splitFile(before);
          applyHunks(file, sec.hunks, oldPath);
          out = joinFile(file);
        }
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.recordMove(oldPath, newPath);
      };
    }

    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (sec.hunks.length > 0) {
        const file = splitFile(before);
        applyHunks(file, sec.hunks, oldPath);
        tree.now.set(oldPath, joinFile(file));
      }
    };
  });
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Set<string>();
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)!) changed.add(p);
  }
  const consumed = new Set<string>();
  const entries: Array<{ key: string; line: string }> = [];
  for (let i = tree.moves.length - 1; i >= 0; i -= 1) {
    const [oldPath, newPath] = tree.moves[i]!;
    if (consumed.has(oldPath) || consumed.has(newPath)) continue;
    if (
      tree.original(oldPath) !== null &&
      tree.get(oldPath) === null &&
      tree.original(newPath) === null &&
      tree.get(newPath) !== null
    ) {
      consumed.add(oldPath);
      consumed.add(newPath);
      entries.push({ key: newPath, line: `R ${oldPath} -> ${newPath}` });
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p)! === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = entries.map((e) => e.line);
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
