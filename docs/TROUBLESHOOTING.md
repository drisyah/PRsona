# Troubleshooting

Deep dependency-debugging notes for `npm install` on a fresh clone — the
node-gyp/rimraf/better-sqlite3 saga, kept out of the README so it stays
scannable. Everything here is context, not a required setup step: if
`npm install && npm start` worked, you can skip this page.

## Why these warnings appear

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

## What not to do

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

## Install scripts

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

## Why `better-sqlite3` never gets compiled here

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
