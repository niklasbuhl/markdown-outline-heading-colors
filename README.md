# Markdown Outline Heading Colors

A **Headings** view for the active Markdown file with its own color, font size and weight per heading level (`#` to `######`). Works in VS Code and VSCodium.

VS Code gives extensions no way to restyle the built-in Outline, and native tree views only allow a label color. So this view is a small webview. It opens in the Explorer; drag it to the secondary sidebar (or wherever the Outline lives) and close the built-in Outline if you like.

## Features
- Per-level color, font size and weight. `#` and `##` bold by default. Colors follow the active theme (text, ANSI blue, cyan, magenta, yellow, then the muted description color); override `markdownOutlineHeadingColors.h1` to `h6` in `workbench.colorCustomizations` or a theme.
- Per-level color, font size and weight. `#` and `##` bold by default.
- Click a heading to jump to it. Click it again (or its chevron) to fold it, in the view and the editor.
- Follows the cursor and expands the view to show it. The title-bar button shows whether it's on (target) or off (circle).
- Fold bar `# ## ### All`: fold to a heading level, in the view and the editor. Expand all / collapse all in the title bar, Fold to ## / ### in its `...` menu. Collapsed sections are remembered per file.
- Keyboard: arrows, Home/End, Left/Right to collapse/expand, Enter to jump, Space to fold.
- Hides Foam `#tags` (not numbers like `#123`). Reads `#` headings and underlined (`===` / `---`) headings. Skips front matter and fenced code blocks.
- Headings with nothing under them have no chevron and don't fold: VS Code has no fold range for them, and folding their line would fold the parent section instead.

## Limitations

- Folds you make directly in the editor (gutter chevrons, `Cmd+K Cmd+0`) don't show in the view. VS Code gives extensions no event or API for folding state.
- Font size and weight need the webview; the built-in Outline can't be restyled.

## Settings

- `markdownOutlineHeadingColors.fontSizes` (default `[17, 15, 13, 13, 12, 12]`): px for `#` to `######`.
- `markdownOutlineHeadingColors.fontWeights` (default `[700, 700, 400, 400, 400, 400]`): 400 normal, 700 bold.
- `markdownOutlineHeadingColors.fontFamily` (default `ui`): `ui` like the Outline, `editor` for your editor font.
- `markdownOutlineHeadingColors.indent` (default `12`): px per level.
- `markdownOutlineHeadingColors.showLevelBar` (default `true`): show the `# ## ### All` fold bar.
- `markdownOutlineHeadingColors.showHashes` (default `false`): prefix labels with `##`.
- `markdownOutlineHeadingColors.hideTags` (default `true`): drop Foam `#tags` from labels.
- `markdownOutlineHeadingColors.followCursor` (default `true`): highlight the heading around the cursor.
- `markdownOutlineHeadingColors.maxLevel` (default `6`): deepest level shown.

## Colors

Theme colors, based on Tokyo Night / Tokyo Night Light. Override them globally or per theme:

```jsonc
"workbench.colorCustomizations": {
  "[Tokyo Night Light]": {
    "markdownOutlineHeadingColors.h1": "#343b58",
    "markdownOutlineHeadingColors.h2": "#34548a",
    "markdownOutlineHeadingColors.h3": "#166775",
    "markdownOutlineHeadingColors.h4": "#5a4a78",
    "markdownOutlineHeadingColors.h5": "#8f5e15",
    "markdownOutlineHeadingColors.h6": "#6c6e75"
  }
}
```

## Install

```sh
cd ~/dev/markdown-outline-heading-colors
npm run package                      # builds markdown-outline-heading-colors-<version>.vsix
code   --install-extension markdown-outline-heading-colors-<version>.vsix
codium --install-extension markdown-outline-heading-colors-<version>.vsix
```

No `code`/`codium` on PATH: Command Palette → "Extensions: Install from VSIX...".

## Develop

Open this folder, press F5. The dev host opens `~/dev/notes`. Tests: `npm install` once, then `npm test` (parser, extension logic against a mocked VS Code API, and the webview in jsdom).

- `extension.js`: parses headings, owns all state (collapsed headings per file, fold level, cursor heading), runs the editor's fold commands. The webview sends intents by heading id (`reveal`, `toggle`, `foldTo`), and the extension re-parses first if the file changed, so lines are never stale.
- `media/main.js`, `media/main.css`: render the tree and report clicks and keys. Theme colors arrive as CSS variables (`--vscode-markdownOutlineHeadingColors-h1`).
- `test/`: `parse.test.js`, `view.test.js`, `webview.test.js`; `helpers/vscode-mock.js` stands in for the `vscode` module.
