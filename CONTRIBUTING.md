# Contributing to PRsona

Thanks for your interest in improving PRsona! This is a local-first tool
used on real pull requests, so contributions that keep it **correct,
private, and easy to verify** are the ones that land fastest.

## Ground rules

- **Be respectful and concrete.** Assume the person on the other side is
  doing their best; review the code, not the coder.
- **Small, focused pull requests.** One concern per PR — a bug fix, one
  feature, or one docs improvement. Large PRs are much harder to review and
  much more likely to stall.
- **Never commit secrets.** API keys and GitHub tokens live in the user's
  local config (`~/Library/Application Support/pr-review-agent/config.json`),
  never in this repository. Don't add telemetry or network calls that send
  user data anywhere.

## Development setup

Prerequisites: **Node ≥ 22** and `npm`.

```bash
git clone https://github.com/<you>/PRsona.git
cd PRsona
npm install     # no compiler needed — better-sqlite3 ships prebuilds (see docs/TROUBLESHOOTING.md)
npm test        # run this before every PR — must be 100% green
npm start       # launch the app with the setup wizard
```

You don't need API keys to run the test suite — it's fully offline.

## Project layout

| Path | What lives there |
|---|---|
| `electron/main.js` | Main process: every `ipcMain.handle` channel |
| `electron/preload.js` | The `window.api` bridge — the only surface the UI may call |
| `src/pipeline/` | The review engine: backfill → categorize → calibrate → review → consolidate |
| `src/db/db.js` | SQLite schema, migrations, and queries (`better-sqlite3`) |
| `src/profile/` | The learned style profile (JSON, one file per reviewer) |
| `renderer/` | The UI: plain HTML/CSS/JS, no framework, no bundler |
| `test/` | Offline test suites (`node:test`-free plain asserts) |

## Making changes

### IPC changes (the most common cross-cutting edit)

Every new main-process channel must be wired through **all three layers**,
or `test/wiring.test.js` will fail:

1. `ipcMain.handle('channel:name', …)` in `electron/main.js`
2. `ipcRenderer.invoke('channel:name', …)` in `electron/preload.js`
3. A `window.api.group.method(…)` call in `renderer/renderer.js`

Every DOM `id` the renderer references must exist in `index.html`, and every
`<button id>` must be referenced from the renderer — both are asserted.

### UI changes

- Class names `warning`, `delta-label`, `delta-select`, `token-row`,
  `step-num`, and `setup-step` are asserted to exist in `styles.css`.
- Keep body-text contrast ≥ 4.5:1 on the dark theme; glow belongs on
  borders and shadows, not on text.
- Respect `prefers-reduced-motion` for new animations.

### Pipeline changes

`test/pipeline.test.js` covers calibration, categorization, delta-type
validity, dedup, and the embeddings degrade path. New behavior needs a
test alongside it — the suite must stay green in full.

## Commit and PR checklist

- [ ] `npm test` passes locally (both suites)
- [ ] New IPC handlers are wired main → preload → renderer
- [ ] No secrets, no telemetry, no new runtime network dependencies
- [ ] README/docs updated if behavior or setup steps changed
- [ ] PR description says **what** changed and **why**, linked to an issue
      when one exists

## Reporting bugs

Open an issue and include:

- OS and version, install method (`npm start` vs packaged app)
- Provider + model (e.g. `ollama/qwen2.5-coder:32b`)
- The exact error text or a screenshot
- Steps to reproduce

## Suggesting features

Open an issue describing the **problem** before the solution — especially
anything that would change what data leaves the machine or what gets posted
to GitHub. Those need discussion first.
