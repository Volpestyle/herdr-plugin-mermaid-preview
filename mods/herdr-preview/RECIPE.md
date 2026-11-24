# Herdr Preview

A dialog mod for Herdr App and Herdr Browser that opens a live Mermaid diagram or transcript image preview for any running Claude Code or Codex terminal.

## What you see

A 480×410 dialog with:

- A header showing **Herdr Preview** and an `Esc` close button.
- Source selector pills (**Mermaid diagrams** and **Transcript images**).
- Placement selector pills (**Tab**, **Split right**, **Split down**), plus a **Native browser** toggle when running inside Herdr Browser (`browser.open` available).
- A scrollable list of live local Claude Code and Codex terminals, showing each agent badge (`claude` / `codex`), terminal title, and `space / tab` location, with the focused agent pre-selected.
- A footer showing keyboard hints and an **Open preview** button.

## How it behaves

- `m` and `i` switch between Mermaid diagrams and transcript images.
- `b` toggles Native browser mode when running in Herdr Browser.
- `↑`/`↓` (or `j`/`k`) move through running Claude Code and Codex terminals; `Enter` or clicking a row opens the preview; `Esc` closes the dialog.
- In terminal mode (Herdr App and Herdr Browser), opening a preview reuses and focuses an already-running preview terminal for that `(terminal, source)` pair, or launches `node <pluginRoot>/src/preview.mjs` in a new tab or split where Herdr renders Kitty graphics natively.
- In Native browser mode (Herdr Browser only), it launches `node <pluginRoot>/src/open-preview.mjs ... --browser`, which serves the offline-rendered PNGs on a token-gated loopback page with live SSE updates and opens it with `browser.open`.

## Built from

- `mods/herdr-preview/mod.json` (`place: "none"`, dialog overlay 480×410).
- `mods/herdr-preview/main.js` using `gpui-kit`, `gpui-base`, and `herdr` (`agents`, `appHome`, `commands`, `exec`, `focused`, `home`, `notify`, `panes`, `props`, `readTextFile`, `run`, `spaces`, `terminals`, `theme`, `closeOverlay`).
- Optional `mods/herdr-preview/config.json` written by `npm run install:app` or `npm run install:browser` with `{ "pluginRoot": "...", "node": "..." }`.

## Watch out

- Only local terminals can be previewed because transcripts are read from `~/.claude` or `~/.codex` on this machine.
- The mod relies on `node` and the cloned `herdr-plugin-mermaid-preview` repository with `npm ci` already run.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/herdr-preview` exits 0 with no errors.
- `herdr-browser check ~/.config/herdr-app-browser/mods/herdr-preview` exits 0 with no errors.
- Opening `mod.open:herdr-preview` lists running Claude Code / Codex terminals and opens a working Mermaid or image preview pane.
