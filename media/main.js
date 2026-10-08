// Renders the Headings tree. The extension owns all state and sends it as
// { type: 'data' } (full state) or { type: 'cursor', id } (cursor moved to
// another heading). The view sends intents back by heading id:
//   ready | reveal {id} | toggle {id, open?} | foldTo {level}
(function () {
  const vscode = acquireVsCodeApi();
  const treeEl = document.getElementById('tree');
  const emptyEl = document.getElementById('empty');
  const levelsEl = document.getElementById('levels');
  const levelBarEl = document.getElementById('levelbar');

  let docKey = null;
  let nodes = [];
  let byId = new Map(); // id -> { node, parent }
  let collapsed = new Set();
  let cursorId; // heading containing the editor cursor
  let follow = true; // highlight and scroll to cursorId
  let level = null; // fold-bar level last applied
  let focusId; // keyboard focus ring
  let lastClickedId; // a second click on this row folds/unfolds it
  let indent = 12;

  const send = (msg) => vscode.postMessage(msg);

  // ---------- state helpers ----------

  function applyStyle(style) {
    indent = style.indent;
    follow = style.followCursor;
    levelBarEl.hidden = !style.levelBar;
    const family = style.family === 'editor' ? 'var(--vscode-editor-font-family)' : 'var(--vscode-font-family)';
    let css = `#tree { font-family: ${family}; }\n`;
    for (let l = 1; l <= 6; l++) {
      css += `.h${l} .label { font-size: ${style.sizes[l - 1]}px; font-weight: ${style.weights[l - 1]}; ` +
        `color: var(--vscode-markdownOutlineHeadingColors-h${l}, var(--vscode-foreground)); }\n`;
    }
    levelsEl.textContent = css;
  }

  function index(list, parent) {
    for (const n of list) {
      byId.set(n.id, { node: n, parent });
      index(n.children, n);
    }
  }

  /** Visible nodes in display order, with depth. */
  function visible() {
    const out = [];
    const walk = (list, depth) => {
      for (const n of list) {
        out.push({ node: n, depth });
        if (n.children.length && !collapsed.has(n.id)) walk(n.children, depth + 1);
      }
    };
    walk(nodes, 0);
    return out;
  }

  const rowOf = (id) => (id ? document.getElementById(`row-${id}`) : null);

  function scrollTo(id) {
    const el = rowOf(id);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // ---------- rendering ----------

  function render() {
    treeEl.textContent = '';
    if (!docKey || !nodes.length) {
      emptyEl.textContent = docKey ? 'No headings in this file.' : 'Open a Markdown file to see its headings.';
      emptyEl.hidden = false;
      treeEl.removeAttribute('aria-activedescendant');
      return;
    }
    emptyEl.hidden = true;

    const frag = document.createDocumentFragment();
    for (const { node, depth } of visible()) {
      const row = document.createElement('div');
      row.className = `row h${node.level}`;
      row.id = `row-${node.id}`;
      row.dataset.id = node.id;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.style.paddingLeft = `${4 + depth * indent}px`;
      if (follow && node.id === cursorId) row.classList.add('active');
      if (node.id === focusId) row.classList.add('focused');

      const tw = document.createElement('span');
      tw.className = 'twistie';
      // Leaves show a chevron only while folded (their body is hidden in the editor).
      if (node.children.length || collapsed.has(node.id)) {
        const open = !collapsed.has(node.id);
        tw.classList.add(open ? 'open' : 'closed');
        row.setAttribute('aria-expanded', String(open));
      }
      row.appendChild(tw);

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.text;
      label.title = `Line ${node.line + 1}`;
      row.appendChild(label);

      frag.appendChild(row);
    }
    treeEl.appendChild(frag);
    const focused = rowOf(focusId);
    if (focused) treeEl.setAttribute('aria-activedescendant', focused.id);
    else treeEl.removeAttribute('aria-activedescendant');
  }

  function renderLevelBar() {
    for (const b of levelBarEl.querySelectorAll('button')) {
      const on = level !== null && Number(b.dataset.level) === level;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  /** Move the cursor highlight without rebuilding rows. */
  function setCursor(id) {
    const prev = rowOf(cursorId);
    if (prev) prev.classList.remove('active');
    cursorId = id;
    if (!follow) return;
    const row = rowOf(id);
    if (row) {
      row.classList.add('active');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Move the focus ring without rebuilding rows, so a click keeps its target. */
  function setFocus(id) {
    const prev = rowOf(focusId);
    if (prev) prev.classList.remove('focused');
    focusId = id;
    const row = rowOf(id);
    if (row) {
      row.classList.add('focused');
      treeEl.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else {
      treeEl.removeAttribute('aria-activedescendant');
    }
  }

  // ---------- intents ----------

  function reveal(id) {
    lastClickedId = id;
    send({ type: 'reveal', id });
  }

  function toggle(id, open) {
    const e = byId.get(id);
    if (e && e.node.foldable) send({ type: 'toggle', id, open });
  }

  // ---------- events ----------

  levelBarEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) send({ type: 'foldTo', level: Number(b.dataset.level) });
  });

  treeEl.addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    const e = byId.get(id);
    if (!e) return;
    setFocus(id);
    if (ev.target.classList.contains('twistie')) {
      toggle(id);
    } else if (id === lastClickedId && e.node.foldable) {
      toggle(id); // second click on the same heading
    } else {
      reveal(id);
    }
  });

  treeEl.addEventListener('keydown', (ev) => {
    const list = visible();
    if (!list.length) return;
    let i = list.findIndex((v) => v.node.id === focusId);
    const cur = i >= 0 ? list[i].node : undefined;
    switch (ev.key) {
      case 'ArrowDown': i = Math.min(list.length - 1, i + 1); setFocus(list[i].node.id); break;
      case 'ArrowUp': i = i < 0 ? 0 : Math.max(0, i - 1); setFocus(list[i].node.id); break;
      case 'Home': setFocus(list[0].node.id); break;
      case 'End': setFocus(list[list.length - 1].node.id); break;
      case 'ArrowRight':
        if (!cur) break;
        if (collapsed.has(cur.id)) toggle(cur.id, true);
        else if (cur.children.length) setFocus(cur.children[0].id);
        break;
      case 'ArrowLeft': {
        if (!cur) break;
        const parent = byId.get(cur.id).parent;
        if (cur.children.length && !collapsed.has(cur.id)) toggle(cur.id, false);
        else if (parent) setFocus(parent.id);
        break;
      }
      case 'Enter':
        if (cur) reveal(cur.id);
        break;
      case ' ':
        if (cur) toggle(cur.id);
        break;
      default:
        return;
    }
    ev.preventDefault();
  });

  treeEl.addEventListener('focus', () => {
    if (focusId && byId.has(focusId)) return;
    const first = (follow && cursorId) || (nodes[0] && nodes[0].id);
    if (first) setFocus(first);
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg && msg.type) {
      case 'data': {
        applyStyle(msg.style);
        if (msg.docKey !== docKey) {
          docKey = msg.docKey;
          focusId = undefined;
          lastClickedId = undefined;
        }
        nodes = msg.nodes;
        byId = new Map();
        index(nodes, undefined);
        collapsed = new Set(msg.collapsed);
        cursorId = msg.cursorId;
        level = msg.level;
        if (!byId.has(focusId)) focusId = undefined;
        if (!byId.has(lastClickedId)) lastClickedId = undefined;
        render();
        renderLevelBar();
        if (msg.scroll && follow) scrollTo(cursorId);
        break;
      }
      case 'cursor':
        // Cursor moved to another heading: the next click on the old one navigates again.
        if (msg.id !== lastClickedId) lastClickedId = undefined;
        setCursor(msg.id);
        break;
    }
  });

  send({ type: 'ready' });
})();
