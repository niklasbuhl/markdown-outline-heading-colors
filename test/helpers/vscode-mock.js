// Minimal stand-in for the `vscode` module: enough for HeadingsView and the
// webview HTML. Install with install() before requiring ../extension.js.
const Module = require('module');

function createVscode() {
  const calls = []; // executeCommand / showTextDocument / update calls, in order
  const config = {};
  const inspect = {};
  const vs = {
    calls,
    config,
    inspect,
    Uri: { joinPath: (base, ...parts) => [String(base), ...parts].join('/') },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Selection: class { constructor(anchor, active) { this.anchor = anchor; this.active = active; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    TextEditorRevealType: { AtTop: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
      getConfiguration: () => ({
        get: (key, def) => (key in config ? config[key] : def),
        inspect: (key) => inspect[key],
        update: async (key, value, target) => {
          config[key] = value;
          calls.push(['update', key, value, target]);
        },
      }),
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      async showTextDocument(doc, opts = {}) {
        calls.push(['show', opts.viewColumn, !!opts.preserveFocus]);
        let ed = this.visibleTextEditors.find((e) => e.document === doc && (opts.viewColumn === undefined || e.viewColumn === opts.viewColumn));
        if (!ed) {
          ed = makeEditor(doc, opts.viewColumn || 1);
          this.visibleTextEditors.push(ed);
        }
        if (!opts.preserveFocus || !this.activeTextEditor) this.activeTextEditor = ed;
        return ed;
      },
    },
    commands: {
      async executeCommand(...args) {
        if (args[0] !== 'setContext') calls.push(args);
      },
    },
  };
  return vs;
}

function makeDoc(text, uri = 'file:///notes/Shop.md') {
  return {
    uri: { toString: () => uri },
    languageId: 'markdown',
    version: 1,
    text,
    getText() { return this.text; },
    edit(text) { this.text = text; this.version++; },
  };
}

function makeEditor(document, viewColumn, line = 0) {
  return {
    document,
    viewColumn,
    selection: { active: { line } },
    revealRange() {},
  };
}

function makeContext() {
  const data = {};
  return {
    extensionUri: 'ext',
    workspaceState: {
      data,
      get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
      update: async (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
    },
  };
}

function install(vs) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? vs : orig.call(this, req, ...rest);
  };
}

module.exports = { createVscode, makeDoc, makeEditor, makeContext, install };
