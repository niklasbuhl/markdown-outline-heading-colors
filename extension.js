// Markdown Outline Heading Colors
// A Headings view for the active Markdown file with per-level color, size and
// weight. Native tree views only allow a label color, so the view is a webview
// (media/main.js renders it). Colors are theme colors
// (markdownOutlineHeadingColors.h1..h6), which VS Code exposes to the webview
// as CSS variables, so workbench.colorCustomizations still works.
//
// The extension owns all state (headings, collapsed set, fold level, cursor
// heading). The webview renders it and sends intents by heading id:
//   ready | reveal {id} | toggle {id, open?} | foldTo {level}

const vscode = require('vscode');

const NS = 'markdownOutlineHeadingColors';
const VIEW_ID = `${NS}.headings`;
const STATE_KEY = 'collapsedByDoc';
const MAX_DOCS = 100;
const DEBOUNCE_MS = 250;

// ---------- parsing ----------

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const BLANK = /^\s*$/;
const INDENTED = /^( {4,}|\t)/;
const BLOCK_START = /^ {0,3}(>|[-+*][ \t]|[-+*]$|\d{1,9}[.)]([ \t]|$)|<)/; // blockquote, list item, HTML
const THEMATIC = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const TAG = /(^|\s)#([\p{L}\p{N}_\-/]+)/gu;

/** Remove Foam #tags from a heading ("Art #wishlist" -> "Art"). Pure numbers ("Issue #123") stay. */
function stripTags(text) {
  return text
    .replace(TAG, (match, pre, tag) => (/^\d+$/.test(tag) ? match : pre))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Can this line be (part of) a paragraph, and so the text of a setext heading? */
function isParagraphLine(line) {
  return !BLANK.test(line)
    && !INDENTED.test(line)
    && !ATX.test(line)
    && !FENCE.test(line)
    && !BLOCK_START.test(line)
    && !THEMATIC.test(line);
}

/**
 * Parse ATX (`## x`) and setext (`x` + `===`/`---`) headings, skipping front
 * matter and fenced code. Each heading gets its section end (last non-blank
 * line before the next heading of the same or higher level) and `foldable`:
 * whether VS Code has a folding range starting at its line. Folding a line
 * with no range of its own folds the enclosing section instead, so callers
 * must skip non-foldable headings.
 * @returns {{level:number, text:string, line:number, end:number, foldable:boolean}[]}
 */
function parseHeadings(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;

  // YAML front matter
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[j])) { i = j + 1; break; }
    }
  }

  let fence = null; // { char, len }
  let paraStart = -1; // first line of the current paragraph, -1 if none
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len
        && BLANK.test(line.slice(line.indexOf(f[1]) + f[1].length))) {
        fence = null;
      }
      continue;
    }
    if (f) { fence = { char: f[1][0], len: f[1].length }; paraStart = -1; continue; }

    const m = ATX.exec(line);
    if (m) {
      out.push({ level: m[1].length, text: (m[2] || '').trim(), line: i });
      paraStart = -1;
      continue;
    }

    const s = paraStart >= 0 ? SETEXT.exec(line) : null;
    if (s) {
      const textLines = lines.slice(paraStart, i).map((l) => l.trim());
      out.push({ level: s[1][0] === '=' ? 1 : 2, text: textLines.join(' '), line: paraStart });
      paraStart = -1;
      continue;
    }

    if (paraStart >= 0 && !BLANK.test(line) && INDENTED.test(line)) continue; // lazy continuation
    if (isParagraphLine(line)) {
      if (paraStart < 0) paraStart = i;
    } else {
      paraStart = -1;
    }
  }

  // Sections: a stack gives each heading its next same-or-higher heading.
  const stack = [];
  const close = (h, nextLine) => {
    let end = nextLine - 1;
    while (end > h.line && BLANK.test(lines[end])) end--;
    h.end = end;
    h.foldable = end > h.line;
  };
  for (const h of out) {
    while (stack.length && stack[stack.length - 1].level >= h.level) close(stack.pop(), h.line);
    stack.push(h);
  }
  while (stack.length) close(stack.pop(), lines.length);

  return out;
}

// ---------- tree ----------

class Heading {
  constructor(h, parent, id) {
    this.level = h.level;
    this.text = h.text;
    this.line = h.line;
    this.end = h.end;
    this.foldable = h.foldable;
    this.parent = parent;
    this.id = id;
    this.children = [];
  }
}

/** Nest flat headings by level. Ids are built from the heading path, so they survive edits elsewhere. */
function buildTree(flat, maxLevel) {
  const roots = [];
  const stack = [];
  const seen = new Map();
  for (const h of flat) {
    if (h.level > maxLevel) continue;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const parent = stack[stack.length - 1];
    const base = `${parent ? parent.id : ''}/${h.level}:${h.text}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    const node = new Heading(h, parent, `${base}#${n}`);
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** Tree in document order. */
function flatten(roots) {
  const out = [];
  const walk = (nodes) => nodes.forEach((n) => { out.push(n); walk(n.children); });
  walk(roots);
  return out;
}

/** Plain data for the webview, with display text applied. */
function serialize(nodes, opts) {
  return nodes.map((n) => {
    let text = opts.hideTags ? stripTags(n.text) : n.text;
    if (opts.showHashes) text = `${'#'.repeat(n.level)} ${text}`;
    return {
      id: n.id,
      level: n.level,
      line: n.line,
      foldable: n.foldable,
      text: text || '(empty heading)',
      children: serialize(n.children, opts),
    };
  });
}

/** Deepest heading at or above `line` in a flat, line-ordered list. */
function headingAt(flat, line) {
  let hit;
  for (const n of flat) {
    if (n.line <= line) hit = n; else break;
  }
  return hit;
}

/**
 * Lines to fold and unfold to show headings down to `level` (0 = expand all).
 * Only foldable headings are included; see parseHeadings.
 */
function foldPlan(flat, level) {
  const fold = [];
  const unfold = [];
  const collapsed = new Set();
  for (const n of flat) {
    if (!n.foldable) continue;
    if (level && n.level >= level) {
      fold.push(n.line);
      collapsed.add(n.id);
    } else {
      unfold.push(n.line);
    }
  }
  return { fold, unfold, collapsed };
}

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------- view ----------

class HeadingsView {
  constructor(context) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.view = undefined;
    this.document = undefined;
    this.version = -1; // document version the headings were parsed from
    this.roots = [];
    this.flat = [];
    this.byId = new Map();
    this.cursorId = undefined; // heading containing the cursor
    this.collapsed = new Set();
    this.level = null; // fold-bar level last applied, null after a manual fold
    this.debounce = undefined;
    this.store = { ...context.workspaceState.get(STATE_KEY, {}) }; // docKey -> { collapsed, level }
  }

  get docKey() {
    return this.document ? this.document.uri.toString() : null;
  }

  config() {
    return vscode.workspace.getConfiguration(NS);
  }

  // ----- webview -----

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    const sub = view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => {
      sub.dispose();
      this.view = undefined;
    });
  }

  html(webview, media) {
    const n = nonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const btn = (level, label, title) =>
      `<button type="button" data-level="${level}" title="${title}" aria-pressed="false">${label}</button>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<style id="levels"></style>
</head>
<body>
<div id="levelbar" role="toolbar" aria-label="Fold to level" hidden>
${btn(1, '#', 'Fold to #')}${btn(2, '##', 'Fold to ##')}${btn(3, '###', 'Fold to ###')}${btn(0, 'All', 'Expand all')}
</div>
<div id="tree" role="tree" tabindex="0" aria-label="Headings"></div>
<p id="empty" hidden></p>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }

  onMessage(msg) {
    switch (msg && msg.type) {
      case 'ready':
        this.post(true);
        break;
      case 'reveal': {
        const node = this.node(msg.id);
        if (node) this.revealLine(node.line);
        break;
      }
      case 'toggle':
        this.toggle(msg.id, msg.open, true);
        break;
      case 'foldTo':
        this.foldTo(Number(msg.level) || 0, true);
        break;
    }
  }

  style() {
    const cfg = this.config();
    const six = (key, fallback) => {
      const v = cfg.get(key);
      return Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === 'number') ? v : fallback;
    };
    return {
      sizes: six('fontSizes', [17, 15, 13, 13, 12, 12]),
      weights: six('fontWeights', [700, 700, 400, 400, 400, 400]),
      family: cfg.get('fontFamily', 'ui'),
      levelBar: cfg.get('showLevelBar', true),
      indent: cfg.get('indent', 12),
      followCursor: cfg.get('followCursor', true),
    };
  }

  /** Send the full state. `scroll` asks the view to bring the cursor heading into view. */
  post(scroll = false) {
    if (!this.view) return;
    const cfg = this.config();
    this.view.webview.postMessage({
      type: 'data',
      docKey: this.docKey,
      nodes: serialize(this.roots, { hideTags: cfg.get('hideTags', true), showHashes: cfg.get('showHashes', false) }),
      collapsed: this.collapsedIds(),
      level: this.level,
      cursorId: this.cursorId,
      style: this.style(),
      scroll,
    });
  }

  // ----- state -----

  setDocument(doc) {
    this.document = doc;
    const saved = doc ? this.store[this.docKey] : undefined;
    this.collapsed = new Set(saved ? saved.collapsed : []);
    this.level = saved && saved.level !== undefined ? saved.level : null;
    this.cursorId = undefined;
    this.rebuild(true);
  }

  save() {
    const key = this.docKey;
    if (!key) return;
    delete this.store[key]; // re-insert so key order tracks recency
    this.store[key] = {
      collapsed: this.collapsedIds(),
      level: this.level,
    };
    const keys = Object.keys(this.store);
    for (let i = 0; i < keys.length - MAX_DOCS; i++) delete this.store[keys[i]];
    this.context.workspaceState.update(STATE_KEY, this.store);
  }

  /** Collapsed ids that exist and can fold in the current parse. */
  collapsedIds() {
    return [...this.collapsed].filter((id) => {
      const n = this.byId.get(id);
      return n && n.foldable;
    });
  }

  scheduleRebuild() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.rebuild(), DEBOUNCE_MS);
  }

  rebuild(scroll = false) {
    clearTimeout(this.debounce);
    this.debounce = undefined;
    const doc = this.document;
    this.roots = doc ? buildTree(parseHeadings(doc.getText()), this.config().get('maxLevel', 6)) : [];
    this.flat = flatten(this.roots);
    this.byId = new Map(this.flat.map((n) => [n.id, n]));
    this.version = doc ? doc.version : -1;

    // Cursor heading, computed before posting so the view gets one message.
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === doc) {
      const node = headingAt(this.flat, editor.selection.active.line);
      this.cursorId = node ? node.id : undefined;
      if (this.config().get('followCursor', true) && this.expandAncestors(this.cursorId)) this.save();
    } else if (this.cursorId && !this.byId.has(this.cursorId)) {
      this.cursorId = undefined;
    }

    vscode.commands.executeCommand('setContext', `${NS}.hasDocument`, !!doc);
    this.post(scroll);
  }

  /** Re-parse now if the document changed since the last parse, so ids map to current lines. */
  ensureFresh() {
    if (this.document && this.document.version !== this.version) this.rebuild();
  }

  node(id) {
    this.ensureFresh();
    return this.byId.get(id);
  }

  /** Un-collapse the ancestors of `id`. Returns true if anything changed. */
  expandAncestors(id) {
    let changed = false;
    for (let n = this.byId.get(id); n && n.parent; n = n.parent) {
      if (this.collapsed.delete(n.parent.id)) changed = true;
    }
    if (changed) this.level = null;
    return changed;
  }

  onCursor(editor) {
    if (!editor || editor.document !== this.document) return;
    const node = headingAt(this.flat, editor.selection.active.line);
    const id = node ? node.id : undefined;
    if (id === this.cursorId) return;
    this.cursorId = id;
    if (this.config().get('followCursor', true) && this.expandAncestors(id)) {
      this.save();
      this.post(true);
    } else if (this.view) {
      this.view.webview.postMessage({ type: 'cursor', id });
    }
  }

  // ----- folding -----

  toggle(id, open, fromView) {
    const node = this.node(id);
    if (!node || !node.foldable) return;
    const isOpen = !this.collapsed.has(id);
    const next = open === undefined || open === null ? !isOpen : !!open;
    if (next === isOpen) return;
    if (next) this.collapsed.delete(id); else this.collapsed.add(id);
    this.level = null;
    this.save();
    this.post();
    this.applyFolds(next ? [] : [node.line], next ? [node.line] : [], fromView);
  }

  /** Show headings down to `level` (0 = expand all), in the view and the editor. */
  foldTo(level, fromView = false) {
    this.ensureFresh();
    if (!this.document) return;
    const plan = foldPlan(this.flat, level);
    this.collapsed = plan.collapsed;
    this.level = level;
    this.save();
    this.post();
    this.applyFolds(plan.fold, plan.unfold, fromView);
  }

  /**
   * Run the editor's fold commands on the editor showing this document. Those
   * commands act on the active editor, so if another editor is active (a split),
   * the document's editor is focused first and, when the request came from the
   * view, focus goes back to the view afterwards.
   */
  async applyFolds(fold, unfold, fromView) {
    if (!this.document || (!fold.length && !unfold.length)) return;
    const editor = await this.showEditor(true);
    let refocus = false;
    if (vscode.window.activeTextEditor !== editor) {
      await this.showEditor(false);
      refocus = fromView;
    }
    if (unfold.length) await vscode.commands.executeCommand('editor.unfold', { levels: 1, selectionLines: unfold });
    if (fold.length) await vscode.commands.executeCommand('editor.fold', { levels: 1, selectionLines: fold });
    if (refocus) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  /** Show the document in the editor that already has it (active one first), not a new tab in another group. */
  showEditor(preserveFocus) {
    const doc = this.document;
    const active = vscode.window.activeTextEditor;
    const target = active && active.document === doc
      ? active
      : vscode.window.visibleTextEditors.find((e) => e.document === doc);
    return vscode.window.showTextDocument(doc, { viewColumn: target ? target.viewColumn : undefined, preserveFocus });
  }

  async revealLine(line) {
    if (!this.document) return;
    const editor = await this.showEditor(false);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  }
}

// ---------- follow cursor ----------

async function setFollowCursor(on) {
  const cfg = vscode.workspace.getConfiguration(NS);
  const inspect = cfg.inspect('followCursor');
  // Write where the effective value comes from, so a workspace setting doesn't override the toggle.
  const target = inspect && inspect.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await cfg.update('followCursor', on, target);
}

function syncFollowContext() {
  const on = vscode.workspace.getConfiguration(NS).get('followCursor', true);
  vscode.commands.executeCommand('setContext', `${NS}.followCursor`, on);
}

// ---------- activation ----------

function activate(context) {
  const view = new HeadingsView(context);
  const isMarkdown = (doc) => doc && doc.languageId === 'markdown';

  const onEditor = (editor) => {
    if (editor && isMarkdown(editor.document)) {
      if (editor.document !== view.document) view.setDocument(editor.document);
      else view.onCursor(editor);
    } else if (editor) {
      // A non-Markdown editor took focus. With no editor (panel focused) keep the last file.
      view.setDocument(undefined);
    }
  };

  const command = (name, fn) => vscode.commands.registerCommand(`${NS}.${name}`, fn);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, view),

    vscode.window.onDidChangeActiveTextEditor(onEditor),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === view.document && e.contentChanges.length) view.scheduleRebuild();
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc === view.document) view.setDocument(undefined);
    }),

    vscode.window.onDidChangeTextEditorSelection((e) => view.onCursor(e.textEditor)),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(NS)) return;
      syncFollowContext();
      view.rebuild();
    }),

    command('refresh', () => view.rebuild()),
    command('expandAll', () => view.foldTo(0)),
    command('collapseAll', () => view.foldTo(1)),
    command('foldTo1', () => view.foldTo(1)),
    command('foldTo2', () => view.foldTo(2)),
    command('foldTo3', () => view.foldTo(3)),
    command('followCursorOn', () => setFollowCursor(true)),
    command('followCursorOff', () => setFollowCursor(false)),
    command('toggleFollowCursor', () => setFollowCursor(!vscode.workspace.getConfiguration(NS).get('followCursor', true))),

    { dispose: () => clearTimeout(view.debounce) }
  );

  syncFollowContext();
  const editor = vscode.window.activeTextEditor;
  if (editor && isMarkdown(editor.document)) view.setDocument(editor.document);
  return { view };
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  parseHeadings,
  buildTree,
  flatten,
  stripTags,
  serialize,
  headingAt,
  foldPlan,
  HeadingsView,
  setFollowCursor,
};
