<div align="center">

# PRsona

### Your AI code reviewer that actually reviews like *you*

PRsona learns a specific person's review style from their own GitHub comment
history and drafts pull-request comments in that voice — running locally,
with your own API keys, posting nothing you haven't approved.

[Features](#features) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Contributing](CONTRIBUTING.md)

[![CI](https://github.com/drisyah/PRsona/actions/workflows/ci.yml/badge.svg)](https://github.com/drisyah/PRsona/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Electron 44](https://img.shields.io/badge/Electron-44-47848f.svg)
![Node >= 22](https://img.shields.io/badge/Node-%3E%3D22-339933.svg)
![Local-first](https://img.shields.io/badge/data-local--first-9b59b6.svg)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

![PRsona dashboard](docs/screenshot-dashboard.png)

</div>

---

## Why another AI reviewer?

CodeRabbit, Copilot, and friends review **like nobody in particular** —
generic comments from a generic model, tuned to nobody's standards, with
your code sent to someone else's cloud.

PRsona inverts the model: your review history *is* the training data.

| | Hosted review bots | **PRsona** |
|---|---|---|
| Style | Generic, one-size-fits-all | Learned from **your** past reviews |
| Data | Sent to the vendor | Stays on **your machine** |
| Model | Locked to their choice | Any: Claude, GPT, local Ollama, OpenAI-compatible |
| Posting | Auto-comments on PRs | Human approves **every** comment |
| Calibration | None | Filters by *your* per-category history |
| Cost | Per-seat SaaS | Free, MIT, bring your own keys |

## How it works

```mermaid
flowchart LR
  A["<b>Backfill</b><br/>your past GitHub<br/>review comments"] --> B["<b>Embed + categorize</b><br/>fixed vocabulary,<br/>vector search in SQLite"]
  B --> C["<b>Calibrate</b><br/>your per-category<br/>comment rates"]
  C --> D["<b>Review a PR</b><br/>analysis pass,<br/>then style pass"]
  D --> E{"You: accept /<br/>edit / reject"}
  E -->|corrections| F["<b>Consolidate</b><br/>profile + rubric<br/>update (you approve)"]
  F -.->|better profile| D
```

1. **Backfill** — pulls the reviewer's past PR comments from GitHub into a
   local SQLite database, categorizes them from a fixed vocabulary, and
   embeds them for retrieval.
2. **Review pipeline** (per PR), two separate LLM calls on purpose:
   - **Analysis pass** — style-agnostic: finds candidate issues in the
     diff, scored against the reviewer's learned rubric.
   - **Calibration** — plain code, not an LLM call: filters issues down to
     roughly match how often this reviewer actually comments on each
     category historically. Findings rare *for you* get elevated; things
     you never comment on get dropped instead of nagging you.
   - **Style pass** — rephrases the surviving issues in the reviewer's real
     voice, grounded in retrieved examples of their actual past comments
     (few-shot), not just an abstract description.
3. **Human review** — drafts are shown in-app; accept / edit / reject each
   one. Every resolution is logged as a "correction." A comment the agent
   missed can be added by hand and is logged too.
4. **Consolidation** (on demand, from the Profile tab) — a separate LLM
   call reads the accumulated corrections and proposes an updated profile
   (rubric + style). You see the diff and approve it before it's written —
   nothing updates silently.

Everything lives in one local SQLite file + one JSON profile file per
reviewer under the app's userData directory. No server, no external
database, no inbound network exposure — the app polls GitHub, GitHub never
calls it.

## Features

- **Learns from real history** — your corpus of past GitHub review
  comments becomes the rubric, the calibration baseline, and few-shot
  style examples.
- **Provider-agnostic** — Anthropic, OpenAI, Ollama (local), or any
  OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp server,
  OpenRouter…). Embeddings can use a *different* provider than the LLM.
- **Human-in-the-loop by construction** — drafts are editable, rejectable,
  and posted as a *pending* GitHub review; nothing notifies anyone until
  you submit from the GitHub UI.
- **Per-step self-tests** — Setup validates the LLM, embeddings, and
  GitHub token *at the field*, and verifying the token auto-fills your
  backfill username.
- **Live dashboard** — the default screen shows reviewer, corpus size,
  sessions, pending feedback, and model at a glance.
- **Offline test suite** — 96 assertions across the pipeline and static
  wiring audit; no network, no API keys needed to test.
- **Honest about limits** — see [Design notes](#design-notes--known-simplifications).

## Screenshots

| Dashboard | Setup |
|---|---|
| ![Dashboard](docs/screenshot-dashboard.png) | ![Setup](docs/screenshot-setup.png) |

| Review |
|---|
| ![Review](docs/screenshot-review.png) |

## Requirements

- Node.js 22+ (for built-in `fetch`; `engines` requires `>=22.0.0` —
  `.nvmrc` pins 24)
- An LLM you can reach: an Anthropic/OpenAI API key, **or** a local runtime
  like [Ollama](https://ollama.com) with a model pulled
  (`ollama pull qwen2.5-coder:32b`, or similar).
- A GitHub personal access token with `repo` scope (for private repos) or
  no scope needed for public-repo read access, plus `pull_request` write
  if you want it to post pending reviews.

## Quick start

```bash
git clone <this repo>
cd PRsona
npm install
npm start
```

On first launch, go to the **Setup** tab:

1. Create a reviewer (a slug like `alice`).
2. Choose an LLM provider and fill in its API key or local base URL.
   - Anthropic and OpenAI don't need a base URL.
   - Ollama defaults to `http://localhost:11434`.
   - "Custom OpenAI-compatible endpoint" covers LM Studio, vLLM,
     llama.cpp's server, OpenRouter, etc. — anything exposing a
     `/v1/chat/completions` route.
3. Optionally set a **separate** embeddings provider — useful if you want a
   frontier model for review reasoning but a free/local model for
   retrieval embeddings. Note: Anthropic doesn't expose an embeddings
   endpoint, so pick OpenAI, Ollama, or a compatible local model for this.
4. Add your GitHub token and the repos to watch.
5. **Save settings**, then use the per-step **Test LLM** / **Test embeddings**
   / **Test GitHub** buttons. Each tests the values currently on screen — not
   the saved config — so a mistake surfaces at the field, not later. Verifying
   the GitHub token also auto-fills your backfill username, since backfill
   matches your exact login (`you` ≠ `Your Name`).
6. Run **Backfill** with the reviewer's GitHub username to ingest, embed,
   and categorize their past review comments. (Categorization makes one LLM
   call per 25 uncategorized comments — only new ones, ever.)

Then use the **Pull Requests** tab to load open PRs and trigger a review —
it's the screen the app opens on, with a live status strip (reviewer, corpus
size, sessions, pending feedback, model) so you can tell at a glance whether
backfill has actually run. The **Review** tab accepts/edits/rejects drafts,
and the **Profile** tab inspects the learned rubric/style and runs
consolidation once you've accumulated some feedback.

### Testing & packaging

```bash
npm test                        # offline: pipeline suite + wiring audit
npm run dist -- --dir           # unpacked app in build/mac-arm64/
npm run dist                    # platform installers (dmg/zip on macOS)
```

The build is unsigned without a Developer ID, so macOS Gatekeeper will
warn on first launch — right-click the app → **Open** to bypass.

## Privacy & your data

- **Nothing leaves the machine except its intended destination.** API keys
  and your GitHub token live in one local config file
  (`~/Library/Application Support/pr-review-agent/config.json` on macOS);
  comments, embeddings, sessions, and corrections live in a local SQLite
  database in the same directory; profiles are plain JSON files under
  `profiles/`.
- **No telemetry, no analytics, no update pings.** The only outbound
  calls are to *your* chosen LLM provider and to the GitHub API.
- **You approve what GitHub sees.** Accepted drafts are assembled into a
  *pending* review — GitHub's unsubmitted state — and a human submits it
  from the GitHub UI as the final check.

## A note on "Claude subscription"

A claude.ai Pro/Max/Team subscription does not include programmatic API
access — this app talks to the Anthropic **Console** API, which is billed
separately per token. If cost matters more than model quality, a local
model via Ollama has no per-token cost at all, at the expense of needing
decent hardware and generally weaker instruction-following than frontier
models (the analysis/style prompts include a `strictness` knob that helps
compensate for this — see `src/pipeline/prompts.js`).

## Project layout

```
electron/           main process (window, IPC handlers) + preload bridge
src/db/              SQLite schema + query helpers (better-sqlite3)
src/llm/             provider abstraction: anthropic / openai / ollama / openai_compat
src/github/          GitHub REST client (backfill, PR diff, posting reviews)
src/pipeline/        analysis → calibrate → style → consolidate + prompts
src/profile/         reviewer profile JSON store + diffing for approval UI
src/config/          local settings store (electron-store)
renderer/            plain HTML/CSS/JS UI — no framework, no build step
test/                offline test suites (npm test)
docs/                screenshots
```

## Design notes / known simplifications

- **Similarity search is brute-force cosine in JS**, not a vector DB. Fine
  for the corpus sizes this tool deals with (hundreds to low thousands of
  comments per reviewer) and keeps the whole app to a single SQLite file.
- **Categorization of backfilled comments is a separate pass** — after
  ingest + embed, `src/pipeline/categorize.js` labels each new comment from
  the fixed vocabulary in `src/pipeline/categories.js`. The analysis pass
  uses the same vocabulary, so calibration can join the two sides on
  category name. It only ever selects rows where `category IS NULL`, so
  re-running backfill never re-bills already-labeled comments, and a batch
  the model answers unparseably is left NULL for the next run instead of
  being stamped `uncategorized`. You can also hand-edit a reviewer's profile
  JSON directly (`<userData>/profiles/<reviewer>.json`) to seed it faster.
- **PR diffs aren't chunked** — very large PRs may exceed context limits,
  especially on local models with smaller windows. A straightforward
  follow-up is to split by file and run the analysis pass per file.
- **GitHub posting uses a pending review** — `createPendingReview` deliberately
  omits the `event` field, which is the only way to get a PENDING
  (unsubmitted) review: sending `event: "COMMENT"` would *submit* it
  immediately (and additionally requires a top-level `body`). Nothing is
  posted or notified until a human opens the PR and submits the review from
  the GitHub UI as a final check. Comments are authored by whichever account
  owns your token, not by the reviewer being modeled, and each one needs a
  file path plus a line present in the diff — GitHub 422s otherwise, so the
  submit button filters those out first.

<details>
<summary><b>npm install warnings &amp; native-module notes</b> (click to expand)</summary>

### Why these warnings appear

If you saw deprecation warnings (`boolean`, `inflight`, `glob@7`, `tar@6.2.1`,
`prebuild-install`, `@npmcli/move-file`) or an audit report with
high/critical vulnerabilities on first install, all of it comes from
`electron-builder`'s transitive dependencies (its nested
`app-builder-lib` → `@electron/rebuild` → `node-gyp@9` → `tar@6` chain) —
the only direct package flagged is `electron-builder` itself.
`better-sqlite3@13` contributes **zero** findings now (it dropped
`prebuild-install`/`node-gyp` entirely). These are `devDependencies` /
build-time only, so they never ship inside the app, and with
`"npmRebuild": false` the vulnerable `node-gyp` code path is never even
executed during packaging. `electron-builder@26` fixes them, but is a
breaking major — worth taking when you next need to touch packaging config.

### What not to do

**Do not add an `overrides` entry for `rimraf`.** This project previously
overrode `rimraf` to `^5.0.10`, which broke `cacache@16`'s dependency
`@npmcli/move-file@2.0.1` — that package calls `promisify(require('rimraf'))`
and `rimraf@5` exports an object, not a function, so any from-source
`node-gyp` build died with
`TypeError: The "original" argument must be of type function`. The override
has been removed; leave `rimraf` to resolve to whatever each package
declares.

Don't run `npm audit fix --force` on this project — with `electron` and
`electron-builder` in the tree it will often "fix" by downgrading them to
versions that break the app. If `npm audit` still shows findings after the
above, check whether they're in `dependencies` (your runtime) or
`devDependencies` (build-time only, e.g. `electron-builder`) — build-time
findings in a local dev tool are lower-risk and usually worth waiting on
upstream for rather than forcing.

### Install scripts

The **`install-scripts`** notice now comes only from `better-sqlite3`: npm
proposes a default `install: node-gyp rebuild` for it (because the tarball
contains a `binding.gyp`), but this project **denies** that script so the
install stays compile-free. These decisions live in the top-level
`allowScripts` field of `package.json`, so they're version-controlled and
apply to fresh clones automatically.

```bash
npm install-scripts ls
# expected: "No packages with unreviewed install scripts."
```

If `better-sqlite3` ever shows as *unreviewed*, re-deny it — do **not**
approve it, or `npm install` will start compiling SQLite from source:

```bash
npm install-scripts deny better-sqlite3
```

**Electron 44 has no install script at all**, so nothing to approve there.
It replaced the old `postinstall` with lazy download: the first time
`electron` runs, `index.js` notices `path.txt`/`dist/` is missing and fetches
the runtime binary on the spot (you'll see `Downloading Electron binary...`).
So right after `npm install`, `node_modules/electron/dist` may legitimately
not exist yet — the first `npm start` populates it. To pre-fetch it without
launching the app:

```bash
npx install-electron
```

If you'd rather avoid a native module altogether: Node 22.5+ ships a
`node:sqlite` module — and unlike Electron 33, Electron 44 does expose it
to the main process (verified: `require('node:sqlite')` works there). It
still isn't a drop-in for this app: `db.js` calls `db.pragma(...)`
for `journal_mode = WAL`, and `node:sqlite` has no `.pragma()` method, so a
migration would mean rewriting those calls as raw `exec()` statements and
adjusting the named-parameter syntax. Left as a future option rather than
done now, since `better-sqlite3@13` already installs with zero compilation.

### Why `better-sqlite3` never gets compiled here

Earlier revisions of this project *could* hit `node-gyp` failures (an
`EBADENGINE` on a new Node, or `rm is not a function` from a bad `rimraf`
override) because installing meant compiling SQLite from source. That whole
class of failure is now structurally impossible — three independent layers
guarantee it:

1. **The package itself refuses to compile — by design.**
   `better-sqlite3@^13` is N-API based: prebuilt binaries for
   `darwin-arm64`/`x64`, `linux`, and `win32` ship *inside the npm tarball*
   under `prebuilds/`, its package sets `gypfile: false`, and it declares no
   `install` script. There is no `node-gyp` step to fail. N-API is
   ABI-stable, so the same binary works across Node **and** Electron
   versions that provide N-API 10 — which is why the old
   `postinstall: electron-rebuild -f -w better-sqlite3` script and the
   `@electron/rebuild` / `node-gyp` devDependencies were removed entirely.
   Requires `"engines": { "node": ">=22.0.0" }`.

   npm nonetheless *proposes* a default `install: node-gyp rebuild` script
   because the tarball contains a `binding.gyp` file. It is explicitly
   **denied** (`npm install-scripts deny better-sqlite3`), so `npm install`
   never runs a compiler. Keep it denied — approving it would start
   compiling from source, which is exactly what this setup avoids.

2. **Electron supplies its own Node runtime** (44.x bundles Node 24 /
   N-API 10 / ABI 149), independent of your system Node. Because
   `better-sqlite3@13` is N-API-based rather than ABI-specific, no
   per-Electron rebuild step is needed — the shipped prebuild loads in both
   plain Node and Electron. If you ever see a `NODE_MODULE_VERSION`
   mismatch, something reinstated an ABI-specific native module; check that
   `better-sqlite3` is still on v13 and that no `postinstall` rebuild script
   has been re-added.

3. **Packaging skips the rebuild too: `"npmRebuild": false`** in the
   `build` field. `electron-builder` otherwise runs `@electron/rebuild` on
   every native module while building `dist`, which would invoke `node-gyp`
   and need Python/make on the build machine. With it off, packaging prints
   `skipped dependencies rebuild reason=npmRebuild is set to false` and
   touches no toolchain. This is safe because asar auto-unpacking keys off
   the presence of `*.node` files (`unpackDetector.isLibOrExe`), not off a
   successful rebuild — `app.asar.unpacked/node_modules/better-sqlite3/prebuilds/`
   gets populated either way. Verified: the packaged app starts and creates
   its SQLite database from inside the archive.

</details>

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup,
the three-layer IPC contract the wiring test enforces, and the PR
checklist. `npm test` must be green (it's fully offline).

## License

[MIT](LICENSE) © 2026 saril

---

<div align="center">

**If PRsona saves you review time, give it a ⭐ — it helps others find it.**

</div>
