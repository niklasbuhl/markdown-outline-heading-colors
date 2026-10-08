// HeadingsView against a mocked vscode API: folding, freshness, splits, state.
const test = require('node:test');
const assert = require('node:assert');
const { createVscode, makeDoc, makeEditor, makeContext, install } = require('./helpers/vscode-mock');

const vs = createVscode();
install(vs);
const { HeadingsView } = require('../extension.js');

const MD = [
  '# Shop', //            0
  'intro', //             1
  '## Home', //           2
  '### Toiletries', //    3  empty leaf: not foldable
  '### Vesterhavsgade', // 4
  '- lamp', //            5
  '## Tech', //           6
  '### Laptop', //        7
  '- mac', //             8
].join('\n');

function setup({ withView = true, text = MD } = {}) {
  vs.calls.length = 0;
  for (const k of Object.keys(vs.config)) delete vs.config[k];
  for (const k of Object.keys(vs.inspect)) delete vs.inspect[k];
  const doc = makeDoc(text);
  const editor = makeEditor(doc, 1, 0);
  vs.window.visibleTextEditors = [editor];
  vs.window.activeTextEditor = editor;
  const context = makeContext();
  const view = new HeadingsView(context);
  const posted = [];
  if (withView) view.view = { webview: { postMessage: (m) => posted.push(m) } };
  view.setDocument(doc);
  vs.calls.length = 0;
  posted.length = 0;
  return { view, doc, editor, context, posted };
}

const id = (view, text) => view.flat.find((n) => n.text === text).id;
const folds = () => vs.calls.filter((c) => c[0] === 'editor.fold' || c[0] === 'editor.unfold');

test('foldTo(3) folds only headings that have a folding range', async () => {
  const { view } = setup();
  view.foldTo(3);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(folds(), [
    ['editor.unfold', { levels: 1, selectionLines: [0, 2, 6] }],
    ['editor.fold', { levels: 1, selectionLines: [4, 7] }], // not 3 (Toiletries)
  ]);
});

test('toggling an empty heading does nothing', async () => {
  const { view, posted } = setup();
  view.toggle(id(view, 'Toiletries'), undefined, true);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(folds(), []);
  assert.strictEqual(posted.length, 0);
});

test('toggle uses current lines when an edit is still debounced', async () => {
  const { view, doc } = setup();
  const laptop = id(view, 'Laptop');
  doc.edit('new first line\n' + MD); // everything moves down one line
  view.scheduleRebuild();
  view.toggle(laptop, false, true);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(folds(), [['editor.fold', { levels: 1, selectionLines: [8] }]]);
  assert.strictEqual(view.debounce, undefined);
});

test('split editor: folds in the document\'s own group, then refocuses the view', async () => {
  const { view, doc } = setup();
  const other = makeEditor(makeDoc('x', 'file:///other.ts'), 2);
  const mdEditor = makeEditor(doc, 1);
  vs.window.visibleTextEditors = [mdEditor, other];
  vs.window.activeTextEditor = other;
  view.toggle(id(view, 'Home'), false, true);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(vs.calls.map((c) => c.slice(0, 1).concat(c[0] === 'show' ? c.slice(1) : [])), [
    ['show', 1, true],
    ['show', 1, false],
    ['editor.fold'],
    ['markdownOutlineHeadingColors.headings.focus'],
  ]);
  assert.strictEqual(vs.window.visibleTextEditors.length, 2, 'no duplicate editor opened');
});

test('palette command works before the view is opened', async () => {
  const { view } = setup({ withView: false });
  view.foldTo(2);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(folds().map((c) => c[1].selectionLines), [[0], [2, 4, 6, 7]]);
  assert.ok(!vs.calls.some((c) => String(c[0]).endsWith('.focus')), 'no refocus for palette commands');
});

test('cursor entering a collapsed section expands and persists', () => {
  const { view, context, editor, posted } = setup();
  view.foldTo(2);
  posted.length = 0;
  editor.selection.active.line = 8; // inside "Laptop" under collapsed "Tech"
  view.onCursor(editor);
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].type, 'data');
  assert.ok(!posted[0].collapsed.includes(id(view, 'Tech')));
  assert.strictEqual(posted[0].level, null);
  const saved = context.workspaceState.data.collapsedByDoc['file:///notes/Shop.md'];
  assert.ok(!saved.collapsed.includes(id(view, 'Tech')));
});

test('cursor move without expansion sends a small cursor message', () => {
  const { view, editor, posted } = setup();
  editor.selection.active.line = 5;
  view.onCursor(editor);
  assert.deepStrictEqual(posted, [{ type: 'cursor', id: id(view, 'Vesterhavsgade') }]);
});

test('rebuild posts one message', () => {
  const { view, posted } = setup();
  view.rebuild();
  assert.strictEqual(posted.length, 1);
});

test('collapse state survives switching files', () => {
  const { view, doc } = setup();
  view.foldTo(2);
  view.setDocument(makeDoc('# Other\ntext', 'file:///other.md'));
  assert.strictEqual(view.collapsed.size, 0);
  view.setDocument(doc);
  assert.strictEqual(view.level, 2);
  assert.ok(view.collapsed.has(id(view, 'Home')));
});

test('follow cursor writes to the scope that sets it', async () => {
  const { setFollowCursor } = require('../extension.js');
  setup();
  await setFollowCursor(false);
  vs.inspect.followCursor = { workspaceValue: true };
  await setFollowCursor(true);
  const updates = vs.calls.filter((c) => c[0] === 'update').map((c) => c[3]);
  assert.deepStrictEqual(updates, [vs.ConfigurationTarget.Global, vs.ConfigurationTarget.Workspace]);
});
