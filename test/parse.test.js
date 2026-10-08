// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createVscode, install } = require('./helpers/vscode-mock');
install(createVscode());
const { parseHeadings, buildTree, flatten, stripTags, serialize, headingAt, foldPlan } = require('../extension.js');

test('parses ATX headings, skips fences and front matter', () => {
  const md = [
    '---', 'title: x', '# not a heading', '---',
    '# Shop', 'text', '## Home', '```', '# code', '```',
    '### Toiletries ##', '~~~~', '## still code', '~~~~', '#nospace', '    # indented code', '## Tech',
  ].join('\n');
  assert.deepStrictEqual(parseHeadings(md).map((h) => [h.level, h.text, h.line]), [
    [1, 'Shop', 4], [2, 'Home', 6], [3, 'Toiletries', 10], [2, 'Tech', 16],
  ]);
});

test('nests by level, handles skipped levels, respects maxLevel', () => {
  const flat = parseHeadings('# A\n### deep\n## B\n#### C\n# D');
  const t = buildTree(flat, 3);
  assert.deepStrictEqual(t.map((n) => n.text), ['A', 'D']);
  assert.deepStrictEqual(t[0].children.map((n) => n.text), ['deep', 'B']);
  assert.strictEqual(t[0].children[1].children.length, 0);
  assert.strictEqual(t[0].children[1].parent, t[0]);
});

test('duplicate headings get distinct ids', () => {
  const t = buildTree(parseHeadings('# A\n## X\n## X'), 6);
  assert.notStrictEqual(t[0].children[0].id, t[0].children[1].id);
});

test('strips #tags but not C# or ##', () => {
  assert.strictEqual(stripTags('Sponsorships #wishlist'), 'Sponsorships');
  assert.strictEqual(stripTags('Art & Fan #wishlist #travel/eu'), 'Art & Fan');
  assert.strictEqual(stripTags('C# notes'), 'C# notes');
  assert.strictEqual(stripTags('#tagonly'), '');
});

test('keeps #123 style numbers', () => {
  assert.strictEqual(stripTags('Issue #123 #todo'), 'Issue #123');
  assert.strictEqual(stripTags('Q #3a'), 'Q');
});

test('parses setext headings like the built-in Outline', () => {
  const md = [
    'Title', '=====', '', 'Intro', '',
    'Two line', 'heading', '---', 'body', '',
    '- list item', '---', '', '---', '', 'text', '    indented continuation', '-',
  ].join('\n');
  assert.deepStrictEqual(parseHeadings(md).map((h) => [h.level, h.text, h.line]), [
    [1, 'Title', 0], [2, 'Two line heading', 5], [2, 'text indented continuation', 15],
  ]);
});

test('setext underline inside a fence or after front matter is ignored', () => {
  const md = ['---', 'a: 1', '---', 'x', '```', 'y', '---', '```'].join('\n');
  assert.deepStrictEqual(parseHeadings(md), []);
});

test('sections: end and foldable', () => {
  const md = [
    '# Shop', //            0
    '## Home', //           1
    '### Toiletries', //    2  empty leaf
    '', //                  3
    '### Vesterhavsgade', // 4
    '- item', //            5
    '', //                  6
    '', //                  7
    '## Empty parent', //   8  only a child
    '### Child', //         9  empty leaf at EOF
    '', //                  10
  ].join('\n');
  const h = parseHeadings(md);
  assert.deepStrictEqual(h.map((x) => [x.text, x.end, x.foldable]), [
    ['Shop', 9, true],
    ['Home', 5, true],
    ['Toiletries', 2, false],
    ['Vesterhavsgade', 5, true],
    ['Empty parent', 9, true],
    ['Child', 9, false],
  ]);
});

test('foldPlan skips headings with no folding range', () => {
  const md = '# A\n## B\n### empty\n### C\ntext\n## D\ntext';
  const flat = flatten(buildTree(parseHeadings(md), 6));
  const p3 = foldPlan(flat, 3);
  assert.deepStrictEqual(p3.fold, [3]); // not line 2 ("### empty"), which would fold "## B"
  assert.deepStrictEqual(p3.unfold, [0, 1, 5]);
  const p0 = foldPlan(flat, 0);
  assert.deepStrictEqual(p0.fold, []);
  assert.deepStrictEqual(p0.unfold, [0, 1, 3, 5]);
  assert.strictEqual(p3.collapsed.size, 1);
});

test('serialize applies hideTags / showHashes', () => {
  const t = buildTree(parseHeadings('# Shop\n## Art #wishlist'), 6);
  const a = serialize(t, { hideTags: true, showHashes: false });
  assert.strictEqual(a[0].children[0].text, 'Art');
  const b = serialize(t, { hideTags: false, showHashes: true });
  assert.strictEqual(b[0].children[0].text, '## Art #wishlist');
  assert.strictEqual(a[0].foldable, true);
  assert.strictEqual(a[0].children[0].foldable, false);
});

test('headingAt finds the enclosing heading', () => {
  const flat = parseHeadings('intro\n# A\ntext\n## B\ntext');
  assert.strictEqual(headingAt(flat, 0), undefined);
  assert.strictEqual(headingAt(flat, 2).text, 'A');
  assert.strictEqual(headingAt(flat, 4).text, 'B');
});
