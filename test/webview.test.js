// media/main.js in jsdom, with the real HTML from extension.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createVscode, install } = require('./helpers/vscode-mock');

install(createVscode());
const { HeadingsView, parseHeadings, buildTree, serialize } = require('../extension.js');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const MD = '# Shop\n## Home\n### Toiletries\n### Vesterhavsgade\ntext\n## Tech\n### Laptop\ntext';
const NODES = serialize(buildTree(parseHeadings(MD), 6), { hideTags: true, showHashes: false });
const STYLE = { sizes: [17, 15, 13, 13, 12, 12], weights: [700, 700, 400, 400, 400, 400], family: 'ui', levelBar: true, indent: 12, followCursor: true };

function idOf(text) {
  const walk = (list) => {
    for (const n of list) {
      if (n.text === text) return n.id;
      const hit = walk(n.children);
      if (hit) return hit;
    }
  };
  return walk(NODES);
}

function load() {
  const html = HeadingsView.prototype.html.call(null, { cspSource: '', asWebviewUri: (u) => u }, 'media')
    .replace(/<script[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(structuredClone(m)) });
  window.Element.prototype.scrollIntoView = function () {};
  window.eval(MAIN);
  const doc = window.document;
  const api = {
    window,
    doc,
    sent,
    last: () => sent[sent.length - 1],
    post: (data) => window.dispatchEvent(new window.MessageEvent('message', { data })),
    data: (extra = {}) => api.post({ type: 'data', docKey: 'k', nodes: NODES, collapsed: [], level: null, cursorId: undefined, style: STYLE, scroll: false, ...extra }),
    row: (text) => doc.getElementById(`row-${idOf(text)}`),
    click: (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    key: (key) => doc.getElementById('tree').dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })),
    rows: () => doc.querySelectorAll('.row').length,
  };
  return api;
}

test('asks for data, then renders all headings', () => {
  const v = load();
  assert.deepStrictEqual(v.sent, [{ type: 'ready' }]);
  v.data();
  assert.strictEqual(v.rows(), 6);
});

test('click jumps, second click folds, by id', () => {
  const v = load();
  v.data();
  v.click(v.row('Home').querySelector('.label'));
  assert.deepStrictEqual(v.last(), { type: 'reveal', id: idOf('Home') });
  v.click(v.row('Home').querySelector('.label'));
  assert.deepStrictEqual(v.last(), { type: 'toggle', id: idOf('Home'), open: undefined });
});

test('second click on a heading with nothing to fold jumps again', () => {
  const v = load();
  v.data();
  v.click(v.row('Toiletries').querySelector('.label'));
  v.click(v.row('Toiletries').querySelector('.label'));
  assert.deepStrictEqual(v.sent.slice(1).map((m) => m.type), ['reveal', 'reveal']);
});

test('cursor moving to another heading resets the second-click state', () => {
  const v = load();
  v.data();
  v.click(v.row('Home').querySelector('.label'));
  v.post({ type: 'cursor', id: idOf('Tech') });
  v.click(v.row('Home').querySelector('.label'));
  assert.strictEqual(v.last().type, 'reveal');
});

test('cursor message moves the highlight without rebuilding rows', () => {
  const v = load();
  v.data({ cursorId: idOf('Home') });
  const home = v.row('Home');
  const tech = v.row('Tech');
  assert.ok(home.classList.contains('active'));
  v.post({ type: 'cursor', id: idOf('Tech') });
  assert.strictEqual(v.row('Tech'), tech, 'same element, no re-render');
  assert.ok(tech.classList.contains('active'));
  assert.ok(!home.classList.contains('active'));
});

test('no highlight when follow cursor is off', () => {
  const v = load();
  v.data({ cursorId: idOf('Home'), style: { ...STYLE, followCursor: false } });
  assert.strictEqual(v.doc.querySelectorAll('.row.active').length, 0);
});

test('collapsed state comes from the extension; chevron sends toggle', () => {
  const v = load();
  v.data({ collapsed: [idOf('Home')] });
  assert.strictEqual(v.rows(), 4);
  assert.strictEqual(v.row('Home').getAttribute('aria-expanded'), 'false');
  v.click(v.row('Home').querySelector('.twistie'));
  assert.deepStrictEqual(v.last(), { type: 'toggle', id: idOf('Home'), open: undefined });
});

test('fold bar sends foldTo and reflects the level with aria-pressed', () => {
  const v = load();
  v.data();
  v.click(v.doc.querySelector('#levelbar button[data-level="2"]'));
  assert.deepStrictEqual(v.last(), { type: 'foldTo', level: 2 });
  v.data({ level: 2 });
  const pressed = [...v.doc.querySelectorAll('#levelbar button')].map((b) => b.getAttribute('aria-pressed'));
  assert.deepStrictEqual(pressed, ['false', 'true', 'false', 'false']);
  v.data({ level: null });
  assert.strictEqual(v.doc.querySelectorAll('#levelbar button.on').length, 0);
});

test('keyboard: arrows move focus, Left folds, Enter jumps, Space folds', () => {
  const v = load();
  v.data();
  v.doc.getElementById('tree').dispatchEvent(new v.window.FocusEvent('focus'));
  v.key('ArrowDown'); // Home
  v.key('ArrowLeft'); // fold Home
  assert.deepStrictEqual(v.last(), { type: 'toggle', id: idOf('Home'), open: false });
  v.key('Enter');
  assert.deepStrictEqual(v.last(), { type: 'reveal', id: idOf('Home') });
  v.key('ArrowDown'); v.key('ArrowDown'); // Vesterhavsgade
  v.key(' ');
  assert.deepStrictEqual(v.last(), { type: 'toggle', id: idOf('Vesterhavsgade'), open: undefined });
});

test('heading text is inserted as text, not HTML', () => {
  const v = load();
  const nodes = serialize(buildTree(parseHeadings('# <img src=x onerror=alert(1)>'), 6), { hideTags: true });
  v.data({ nodes });
  assert.strictEqual(v.doc.querySelectorAll('img').length, 0);
  assert.strictEqual(v.doc.querySelector('.label').textContent, '<img src=x onerror=alert(1)>');
});

test('empty states', () => {
  const v = load();
  v.data({ docKey: null, nodes: [] });
  assert.match(v.doc.getElementById('empty').textContent, /Open a Markdown file/);
  v.data({ nodes: [] });
  assert.match(v.doc.getElementById('empty').textContent, /No headings/);
});
