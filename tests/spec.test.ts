import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../runner.ts';

function run(argv: string[], stdin: string | null, files: Record<string, string> = {}) {
  return runCheck({ id: 'test', argv, stdin, files });
}

describe('SPEC §1-§4: CLI, output, paths, format detection', () => {
  it('handles usage errors and option ordering', () => {
    assert.equal(run(['--unknown'], '').exit, 2);
    assert.equal(run(['--unknown'], '').stdout, 'error: usage\n');
    assert.equal(run(['--check', '--check'], '').stdout, 'error: usage\n');
    assert.equal(run(['--strict', '--strict'], '').stdout, 'error: usage\n');
    assert.equal(run(['--format=auto', '--format=json'], '').stdout, 'error: usage\n');
    assert.equal(run(['--format=bogus'], '').stdout, 'error: usage\n');
    assert.equal(run(['a.diff', 'b.diff'], '').stdout, 'error: usage\n');
    // usage wins over no-patch
    assert.equal(run(['--check', '--check', 'missing.diff'], null).stdout, 'error: usage\n');
  });

  it('supports -- to allow patch file starting with -', () => {
    const patch = JSON.stringify([{ command: 'create', path: 'a.txt', file_text: 'hi\n' }]);
    const r = run(['--check', '--', '-patch.json'], null, { '-patch.json': patch });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, 'A a.txt\nok: 1 file\n');
    assert.equal(r.files['a.txt'], undefined);
  });

  it('returns error: no-patch when patch file is missing or is a directory', () => {
    const r = run(['nope.diff'], null);
    assert.equal(r.exit, 2);
    assert.equal(r.stdout, 'error: no-patch\n');
  });

  it('returns error: format on undetectable input with auto, error: parse 1 on empty explicit format', () => {
    assert.equal(run([], 'hello world\n').stdout, 'error: format\n');
    assert.equal(run(['--format=unified'], 'hello world\n').stdout, 'error: parse 1\n');
    assert.equal(run(['--format=search-replace'], 'hello world\n').stdout, 'error: parse 1\n');
    assert.equal(run(['--format=v4a'], '*** Begin Patch\n*** End Patch\n').stdout, 'error: parse 1\n');
    assert.equal(run(['--format=json'], '[]\n').stdout, 'error: parse 1\n');
  });

  it('sorts output paths in UTF-8 byte order', () => {
    const patch = JSON.stringify([
      { command: 'create', path: 'b.txt', file_text: '1' },
      { command: 'create', path: 'Z.txt', file_text: '1' },
      { command: 'create', path: 'a.txt', file_text: '1' },
      { command: 'create', path: 'a/x.txt', file_text: '1' },
      { command: 'create', path: 'a0.txt', file_text: '1' },
    ]);
    const r = run([], patch);
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, 'A Z.txt\nA a.txt\nA a/x.txt\nA a0.txt\nA b.txt\nok: 5 files\n');
  });

  it('rejects unsafe paths before checking existence', () => {
    const unsafePaths = ['', '/etc/passwd', 'a\\b', 'a//b', './a', 'a/./b', '../a', 'a/../b', 'a/'];
    const patch = JSON.stringify(unsafePaths.map((p) => ({ command: 'create', path: p, file_text: 'x' })));
    const r = run([], patch);
    assert.equal(r.exit, 1);
    const expected = unsafePaths.map((p) => `error: unsafe ${p}`).join('\n') + `\nfailed: ${unsafePaths.length} of ${unsafePaths.length} edits\n`;
    assert.equal(r.stdout, expected);
  });

  it('allows deleting a file and creating a file under a directory of the same name', () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: foo',
      '*** Add File: foo/bar.txt',
      '+hello',
      '*** End Patch',
    ].join('\n') + '\n';
    const r = run([], patch, { foo: 'old\n' });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, 'D foo\nA foo/bar.txt\nok: 2 files\n');
    assert.deepEqual(r.files, { 'foo/bar.txt': 'hello\n' });
  });

  it('reports ok: 0 files when edits cancel out', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: tmp.txt',
      '+x',
      '*** Delete File: tmp.txt',
      '*** Update File: keep.txt',
      '*** Move to: moved.txt',
      '*** Update File: moved.txt',
      '*** Move to: keep.txt',
      '*** End Patch',
    ].join('\n') + '\n';
    const r = run([], patch, { 'keep.txt': 'same\n' });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, 'ok: 0 files\n');
    assert.deepEqual(r.files, { 'keep.txt': 'same\n' });
  });
});

describe('SPEC §5: Three-tier matching, context preservation, tier-2 re-indent', () => {
  it('preserves file context lines at tier 1 and tier 2, and re-indents added lines at tier 2', () => {
    const file = '    alpha  \n    beta\t\n    gamma\n';
    const patch = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,5 @@',
      '   alpha',
      '-  beta',
      '+  BETA',
      '+    NESTED',
      '+',
      '+NO_PREFIX',
      '   gamma',
    ].join('\n') + '\n';
    const r = run([], patch, { 'f.txt': file });
    assert.equal(r.exit, 0);
    assert.equal(
      r.files['f.txt'],
      '    alpha  \n    BETA\n      NESTED\n\nNO_PREFIX\n    gamma\n',
    );
  });

  it('re-indents when P is empty and F is non-empty', () => {
    const file = '\t\told1\n\t\told2\n';
    const patch = [
      'f.txt',
      '<<<<<<< SEARCH',
      'old1',
      'old2',
      '=======',
      'new1',
      '  indented',
      '   ',
      '>>>>>>> REPLACE',
    ].join('\n') + '\n';
    const r = run([], patch, { 'f.txt': file });
    assert.equal(r.exit, 0);
    assert.equal(r.files['f.txt'], '\t\tnew1\n\t\t  indented\n   \n');
  });

  it('enforces tier 0 only with --strict', () => {
    const file = 'hello  \n';
    const patch = [
      'f.txt',
      '<<<<<<< SEARCH',
      'hello',
      '=======',
      'world',
      '>>>>>>> REPLACE',
    ].join('\n') + '\n';
    assert.equal(run(['--strict'], patch, { 'f.txt': file }).exit, 1);
    assert.equal(run(['--strict'], patch, { 'f.txt': file }).stdout, 'error: no-match f.txt\nfailed: 1 of 1 edits\n');
    assert.equal(run([], patch, { 'f.txt': file }).exit, 0);
  });
});

describe('SPEC §6: Unified diffs edge cases', () => {
  it('detects parse errors with exact line numbers', () => {
    assert.equal(run(['--format=unified'], 'diff --git bad\n').stdout, 'error: parse 1\n');
    assert.equal(
      run(['--format=unified'], 'diff --git a/x b/x\n--- a/x\nnot-plus\n').stdout,
      'error: parse 3\n',
    );
    assert.equal(run(['--format=unified'], '@@ -1,1 +1,1 @@\n').stdout, 'error: parse 1\n');
    assert.equal(
      run(['--format=unified'], '--- a/x\n+++ b/x\n@@ bogus @@\n').stdout,
      'error: parse 3\n',
    );
  });

  it('handles --- line inside hunk body and strips trailing empty lines but keeps space context', () => {
    const file = 'a\n-- dash\nb\n\nc\n';
    const patch = [
      '--- a/f.txt\t2026-01-01',
      '+++ b/f.txt\t2026-01-01',
      '@@ -1,4 +1,4 @@',
      ' a',
      '--- dash',
      '+-- replaced',
      ' b',
      ' ',
      '',
      '',
    ].join('\n') + '\n';
    const r = run([], patch, { 'f.txt': file });
    assert.equal(r.exit, 0);
    assert.equal(r.files['f.txt'], 'a\n-- replaced\nb\n\nc\n');
  });

  it('picks nearest occurrence to A - 1 + d and breaks ties to earlier', () => {
    const file = 'x\ntarget\nx\nx\nx\ntarget\nx\n'; // target at 1 and 5; midpoint is 3 (1-based line 4)
    const patch = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -4,1 +4,1 @@',
      '-target',
      '+FIRST_TIE',
    ].join('\n') + '\n';
    const r = run([], patch, { 'f.txt': file });
    assert.equal(r.exit, 0);
    assert.equal(r.files['f.txt'], 'x\nFIRST_TIE\nx\nx\nx\ntarget\nx\n');
  });

  it('handles \\ No newline on creation, EOF modification, mid-file modification, and EOF deletion', () => {
    // 1. Creation without final newline
    const pCreate = '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n';
    const r1 = run([], pCreate);
    assert.equal(r1.exit, 0);
    assert.equal(r1.files['new.txt'], 'one\ntwo');

    // 2. Mid-file modification preserves missing final newline
    const pMid = '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n';
    const r2 = run([], pMid, { 'f.txt': 'one\ntwo\nthree' });
    assert.equal(r2.exit, 0);
    assert.equal(r2.files['f.txt'], 'ONE\ntwo\nthree');

    // 3. EOF deletion restores trailing newline on preceding line
    const pDel = '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n one\n-two\n\\ No newline at end of file\n';
    const r3 = run([], pDel, { 'f.txt': 'one\ntwo' });
    assert.equal(r3.exit, 0);
    assert.equal(r3.files['f.txt'], 'one\n');
  });

  it('handles pure rename, empty creation via new file mode, deletion ignoring hunks, and unsafe after stripping a/', () => {
    const pRename = 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n';
    const r1 = run([], pRename, { 'old.txt': 'abc' });
    assert.equal(r1.exit, 0);
    assert.equal(r1.stdout, 'R old.txt -> new.txt\nok: 1 file\n');
    assert.deepEqual(r1.files, { 'new.txt': 'abc' });

    const pEmptyNew = 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n';
    const r2 = run([], pEmptyNew);
    assert.equal(r2.exit, 0);
    assert.deepEqual(r2.files, { 'empty.txt': '' });

    const pDelIgnore = '--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-does not match file at all\n';
    const r3 = run([], pDelIgnore, { 'gone.txt': 'different\n' });
    assert.equal(r3.exit, 0);
    assert.deepEqual(r3.files, {});

    const pUnsafe = '--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n';
    const r4 = run([], pUnsafe);
    assert.equal(r4.exit, 1);
    assert.equal(r4.stdout, 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n');
  });
});

describe('SPEC §7: SEARCH/REPLACE edge cases', () => {
  it('skips code fences for path, reuses previous path, and detects overlapping ambiguity', () => {
    const patch = [
      'dir/f.txt',
      '```txt',
      '<<<<<<< SEARCH  ',
      'a',
      'a',
      '=======  ',
      'b',
      '>>>>>>> REPLACE  ',
      '```',
      '',
      '```txt',
      '<<<<<<< SEARCH',
      'x',
      '=======',
      'y',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n') + '\n';
    const r = run([], patch, { 'dir/f.txt': 'a\na\na\nx\n' });
    assert.equal(r.exit, 1);
    assert.equal(r.stdout, 'error: ambiguous dir/f.txt\nfailed: 1 of 2 edits\n');
    assert.equal(r.files['dir/f.txt'], 'a\na\na\nx\n');
  });

  it('reports parse errors on SEARCH line', () => {
    assert.equal(run(['--format=search-replace'], '```\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n').stdout, 'error: parse 2\n');
    assert.equal(run(['--format=search-replace'], 'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n').stdout, 'error: parse 2\n');
    assert.equal(run(['--format=search-replace'], 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n').stdout, 'error: parse 2\n');
  });

  it('creates empty file when both old and new are empty', () => {
    const patch = 'empty.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n';
    const r = run([], patch);
    assert.equal(r.exit, 0);
    assert.deepEqual(r.files, { 'empty.txt': '' });
  });
});

describe('SPEC §8: V4A patches edge cases', () => {
  it('enforces Begin/End Patch, Update File non-empty, and End of File rules', () => {
    assert.equal(run(['--format=v4a'], '\nbad\n*** End Patch\n').stdout, 'error: parse 2\n');
    assert.equal(run(['--format=v4a'], '*** Begin Patch\n*** Delete File: a\n').stdout, 'error: parse 3\n');
    assert.equal(
      run(['--format=v4a'], '*** Begin Patch\n*** Update File: a\n*** End Patch\n').stdout,
      'error: parse 2\n',
    );
    assert.equal(
      run(['--format=v4a'], '*** Begin Patch\n*** Update File: a\n*** End of File\n*** End Patch\n').stdout,
      'error: parse 3\n',
    );
    assert.equal(
      run(
        ['--format=v4a'],
        '*** Begin Patch\n*** Update File: a\n-x\n+y\n*** End of File\n-z\n+w\n*** End Patch\n',
      ).stdout,
      'error: parse 6\n',
    );
  });

  it('supports stacked @@ anchors, first chunk without @@, EOF anchoring, and pure Move to', () => {
    const file = 'class A:\n  def f():\n    x = 1\nclass B:\n  def f():\n    x = 1\n    tail = 1\n    tail = 1\n';
    const patch = [
      '*** Begin Patch',
      '*** Update File: code.py',
      '@@ class B:',
      '@@ def f():',
      '-    x = 1',
      '+    x = 2',
      '@@',
      '-    tail = 1',
      '+    tail = 99',
      '*** End of File',
      '*** Update File: pure.txt',
      '*** Move to: pure2.txt',
      '*** End Patch',
    ].join('\n') + '\n';
    const r = run([], patch, { 'code.py': file, 'pure.txt': 'hi' });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, 'M code.py\nR pure.txt -> pure2.txt\nok: 2 files\n');
    assert.equal(
      r.files['code.py'],
      'class A:\n  def f():\n    x = 1\nclass B:\n  def f():\n    x = 2\n    tail = 1\n    tail = 99\n',
    );
    assert.equal(r.files['pure2.txt'], 'hi');
    assert.equal(r.files['pure.txt'], undefined);
  });

  it('checks Move to path safety before checking missing source', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: missing.txt',
      '*** Move to: ../evil.txt',
      '*** End Patch',
    ].join('\n') + '\n';
    const r = run([], patch);
    assert.equal(r.exit, 1);
    assert.equal(r.stdout, 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n');
  });

  it('handles rename followed by recreate of old path (not R)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '*** Move to: b.txt',
      '*** Add File: a.txt',
      '+recreated',
      '*** End Patch',
    ].join('\n') + '\n';
    const r = run([], patch, { 'a.txt': 'orig\n' });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, 'M a.txt\nA b.txt\nok: 2 files\n');
    assert.deepEqual(r.files, { 'a.txt': 'recreated\n', 'b.txt': 'orig\n' });
  });
});

describe('SPEC §9: JSON edits edge cases', () => {
  it('handles overlapping str_replace, CRLF, insert bounds, and array parse line number', () => {
    const r1 = run([], JSON.stringify([{ command: 'str_replace', path: 'a.txt', old_str: 'aa', new_str: 'b' }]), {
      'a.txt': 'aaa',
    });
    assert.equal(r1.exit, 1);
    assert.equal(r1.stdout, 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n');

    const r2 = run([], '\n\n[\n  {"command": "bogus", "path": "a"}\n]\n');
    assert.equal(r2.exit, 2);
    assert.equal(r2.stdout, 'error: parse 3\n');

    const r3 = run(
      [],
      JSON.stringify([
        { command: 'insert', path: 'c.txt', insert_line: 0, new_str: 'top\r\n' },
        { command: 'insert', path: 'c.txt', insert_line: 3, new_str: 'bot' },
      ]),
      { 'c.txt': 'one\r\ntwo' },
    );
    assert.equal(r3.exit, 0);
    assert.equal(r3.files['c.txt'], 'top\r\none\r\ntwo\r\nbot');
  });
});
