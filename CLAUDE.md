# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

txiki.js is a small JavaScript runtime built on QuickJS-ng (JS engine), libuv (platform I/O), and libwebsockets (HTTP/WebSocket). It targets WinterTC compliance and provides Web Platform APIs.

## Build Commands

```bash
make                # Build (Release). Output: build/tjs
make debug          # Build (Debug)
make js             # Rebuild JS bundles only (after editing src/js/)
make test           # Run all tests
make test-advanced  # Run advanced/integration tests (requires npm install in tests/advanced/)
make format         # Run clang-format on C sources
make lint           # Run ESLint on JS sources
```

After modifying files in `src/js/`, run `make js && make` to rebuild.

After modifying C files, just run `make`.

### Build Options

```bash
BUILDTYPE=Debug make          # Debug build
MIMALLOC=OFF make             # Disable mimalloc (required for ASAN)
BUILD_WITH_ASAN=ON MIMALLOC=OFF make  # Enable AddressSanitizer (must disable mimalloc)
BUILD_WITH_UBSAN=ON make      # Enable UndefinedBehaviorSanitizer (Linux/macOS only)
BUILD_WITH_GC_STRESS=ON make  # Force a full GC before every JS allocation (GC stress)
BUILD_WITH_WASM=OFF make      # Disable WebAssembly / WAMR (drops the WebAssembly global and tjs:wasi)
BUILD_WITH_SQLITE=OFF make    # Disable SQLite (drops the tjs:sqlite module; localStorage falls back to in-memory)
```

#### Size-optimized builds

These flags shrink the binary; they are orthogonal to one another and can be combined.

```bash
BUILD_WITH_STRIP=ON make        # Strip the symbol table from the binary after linking
BUILD_WITH_LTO=ON make          # Enable link-time optimization (slower link, smaller/faster binary)
BUILD_WITH_GC_SECTIONS=ON make  # Per-function/data sections + linker dead-code stripping
BUILDTYPE=MinSizeRel make       # Optimize for size instead of speed (-Os)
```

`BUILD_WITH_STRIP` runs `${CMAKE_STRIP}` as a post-build step (skipped when `CMAKE_STRIP` is
unset, e.g. MSVC). `BUILD_WITH_LTO` falls back to a warning if the toolchain can't do IPO.
`BUILD_WITH_GC_SECTIONS` maps to `-Wl,--gc-sections` (GNU/lld), `-Wl,-dead_strip` (Apple), or
`/OPT:REF /OPT:ICF` (MSVC). `BUILDTYPE=MinSizeRel` is a standard CMake build type (no extra flag).

ASAN and mimalloc are mutually exclusive. UBSAN is not supported on MSVC.

### Sanitizer Builds

**ASAN** (AddressSanitizer): Detects memory errors (use-after-free, buffer overflow, etc.).
```bash
cmake -B build-asan -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_WITH_ASAN=ON -DBUILD_WITH_MIMALLOC=OFF
cmake --build build-asan
./build-asan/tjs test tests/
```

**UBSAN** (UndefinedBehaviorSanitizer): Detects undefined behavior (misaligned access, integer overflow, etc.).
```bash
cmake -B build-ubsan -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_WITH_UBSAN=ON
cmake --build build-ubsan
UBSAN_OPTIONS="halt_on_error=1:suppressions=$(pwd)/ubsan.supp" ./build-ubsan/tjs test tests/
```

UBSAN requires a suppressions file (`ubsan.supp`) for known issues in vendored dependencies (WAMR alignment). Fix UBSan issues in our own code (`src/`) rather than adding suppression rules.

### GC Stress Testing

`BUILD_WITH_GC_STRESS=ON` defines QuickJS's `FORCE_GC_AT_MALLOC`, which runs a full garbage collection before *every* JS object allocation. This surfaces GC bugs — objects that are collected while still referenced (missing GC roots / mark hooks). Such premature frees usually only manifest as use-after-free, so combine it with ASAN to actually catch them:
```bash
cmake -B build-gcstress -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_WITH_GC_STRESS=ON -DBUILD_WITH_ASAN=ON -DBUILD_WITH_MIMALLOC=OFF
cmake --build build-gcstress
TJS_GC_STRESS=1 ./build-gcstress/tjs test tests/
```

Set `TJS_GC_STRESS=1` when running the test suite against a GC-stress build: a full GC before every allocation starves the event loop, so a handful of timing-sensitive tests (e.g. `test-performance`) skip themselves when that variable is set rather than failing on wall-clock assertions. The first `tjs bundle` call (esbuild download) is implemented in JS and is pathologically slow under GC stress, so the CI job warms the shared `~/.tjs` esbuild cache with a normal build first.

GC stress is orthogonal to the allocator and the sanitizers; it just changes the GC trigger threshold. It makes execution drastically slower (a full GC per allocation), so the CI job runs it on Linux only.

## Running Tests

```bash
./build/tjs test tests/                    # All tests
./build/tjs run tests/test-something.js    # Single test file (use "run", not "test")
VERBOSE_TESTS=1 ./build/tjs test tests/    # Verbose output
```

Test files must be named `test-*.js` and live in `tests/`. They use `tjs:assert` for assertions.

**One test, one file.** Each test file should cover a single feature or behavior. Prefer
splitting distinct behaviors into separate `test-*.js` files (e.g. `test-fetch-h2-post-body.js`,
`test-fetch-h2-empty-body.js`) over accumulating many unrelated cases in one file — a focused
file is easier to run in isolation (`tjs run tests/test-foo.js`) and makes a failure point
directly at the behavior that broke.

### Feature-gated tests

When a test file requires a feature that can be compiled out (e.g. `BUILD_WITH_WASM=OFF`),
add its filename or glob to the matching feature key in `tests/feature-skip.json`. The test
runner reads this file and skips matched tests on builds where the feature is absent
(detected via `tjs.engine.features`). Only `*` wildcards at a single position are supported
(no `**`, no `?`).

## Architecture

### Two-Layer Design: C modules + JS polyfills

**C layer** (`src/`): Native modules (`mod_*.c`) expose low-level APIs to JS via QuickJS bindings. Key files:
- `vm.c` / `private.h` — TJSRuntime lifecycle (QuickJS runtime + libuv loop)
- `builtins.c` — Registers all native modules
- `cli.c` — Entry point, CLI argument parsing
- `mod_*.c` — Native module implementations (fs, os, process, dns, udp, tls, sqlite3, ffi, etc.)
- `httpclient.c` / `httpserver.c` / `ws.c` — HTTP and WebSocket via libwebsockets
- `webcrypto.c` — Web Crypto API
- `wasm.c` — WebAssembly via WAMR

**JS layer** (`src/js/`): Builds on C APIs to implement Web Platform interfaces.
- `polyfills/` — Browser API polyfills (EventTarget, fetch, WebSocket, console, crypto, etc.). **Import order in `index.js` matters** — dependencies before dependents.
- `core/` — Initializes the `tjs` global object
- `stdlib/` — Standard library modules importable as `tjs:modulename` (path, fs, http, sqlite, ffi, etc.)
- `run-main/` — CLI subcommands (test runner, bundler, compiler)
- `run-repl/` — REPL implementation
- `worker/` — Web Worker bootstrap

### JS Bundle Pipeline

JS source → esbuild bundle → tjsc (QuickJS bytecode compiler) → C byte arrays → compiled into binary.

Generated files live in `src/bundles/` (git-ignored). The Makefile `js` target runs this pipeline.

### Dependencies (deps/)

All vendored as git submodules: quickjs, libuv, mimalloc, sqlite3, libwebsockets, mbedtls, wamr, miniz, tweetnacl, ada.

## Code Conventions

- C code follows `.clang-format` style; run `make format` before committing
- Prefer `Promise.withResolvers()` for deferred promises
- Platform-specific C code uses `#ifdef _WIN32` / `#ifndef _WIN32` guards
- Stdlib modules are imported as `tjs:modulename` (e.g., `import assert from 'tjs:assert'`)
- Comment only what the code can't say itself. Add a comment when the *why* is
  non-obvious — an unusual approach, a subtle invariant, a workaround, a non-local
  consequence. Do **not** add comments that restate what the code plainly does; if
  reading the code tells you the same thing, the comment is noise. Delete such comments.
- Don't defend against states that can't happen. If an invariant must always hold,
  assert it with `CHECK(...)` (which aborts), not with a fallback branch that
  silently "handles" the impossible case. Fallback-for-the-impossible hides bugs;
  a `CHECK` documents the invariant and fails loudly if it is ever violated.
- In JS classes, keep internal state in real private fields (`#foo`), never in
  `_foo`-prefixed public properties. When another class in the same module needs
  access, expose a module-private accessor from a `static {}` block instead of
  widening the public API. Use a module-scoped `Symbol` key only for state that
  must hang off an object of another class (e.g. pinning an owner on a native
  object to keep it alive).

---

# Fork additions (slim builds)

Everything below is specific to this fork (`lukasMega/txiki.js-with-slim-builds`, branch
`slim`). It is kept in one block at the end of the file, and the sections above are left
byte-identical to upstream, so an upstream edit to them never conflicts. Where a statement
above is no longer true for this fork, it is corrected here.

## Extra build options

```bash
BUILD_WITH_TLS=OFF make       # Disable TLS (drops HTTPS/WSS and TLSSocket; WebCrypto unaffected)
BUILD_WITH_BUNDLED_CA=OFF make  # (TLS builds only) Drop the embedded Mozilla CA bundle; requires
                                 # TJS_CA_BUNDLE/setCABundlePath at runtime, or HTTPS/WSS/TLSSocket
                                 # fail cert verification with a clear error (never silently insecure)
BUILD_WITH_WEBCRYPTO=OFF make   # LITE profile only, WinterTC-breaking: drops crypto.subtle
                                 # (crypto.getRandomValues/randomUUID still work). Also breaks
                                 # `tjs app pack`/`tjs app compile`, which hash the package via
                                 # crypto.subtle.digest.
BUILD_WITH_FFI=OFF make         # Disable libffi (drops the tjs:ffi module)
```

The active set is readable at runtime from `tjs.engine.features`
(`wasm`, `sqlite`, `tls`, `bundledCa`, `webcrypto`, `ffi`).

**Every option this fork adds lives in `cmake/slim.cmake`**, not in `CMakeLists.txt` — upstream
edits `CMakeLists.txt` constantly, so the fork's delta there is deliberately kept to one
`include()` plus six `tjs_slim_*()` call sites. CMake is imperative, so the split is not
arbitrary: the option declarations and directory-scoped compile flags run at the `include()`,
and each `tjs_slim_configure_*` function runs at the one point where its target or dependency
already exists. Add new fork-only build options there, and call them from the matching function.

`tjs_slim_configure_core()` also *removes* `src/cacert.c`, `src/mod_tls.c`, `src/ed25519.c` and
`src/webcrypto.c` from the `tjs` target when their option is off, so upstream's `add_library(tjs
…)` source list stays byte-identical to upstream's. It hard-errors if one of those paths is no
longer a source of the target — otherwise an upstream rename would silently compile the file
back in.

The same split is applied to the `Makefile`: every fork-only variable and esbuild flag lives in
`slim.mk`, and the Makefile's delta is a single `-include slim.mk`. The two bundle overrides
there are GNU-make target-specific variables (`src/bundles/js/core/run-main.js:
ESBUILD_PARAMS_COMMON += …`), which is what keeps upstream's recipes untouched. Adding those
flags globally would also apply `--minify-syntax` to the core/repl/stdlib bundles and change
their committed bytecode.

The embedded CA bundle (`src/cacert.c`, regenerated by `scripts/update-ca-bundle.sh`) is stored
miniz/zlib-compressed and inflated lazily on first TLS use, cached on the runtime. Note lws's
`LWS_SSL_CLIENT_USE_OS_CA_CERTS` is only implemented for its OpenSSL/SChannel backends, not
mbedtls (which txiki.js always builds lws with), so `BUILD_WITH_BUNDLED_CA=OFF` does **not** fall
back to the OS trust store in practice — a `TJS_CA_BUNDLE`/`setCABundlePath` override is required.

### Extra size-optimized builds

On top of upstream's `BUILD_WITH_STRIP` / `BUILD_WITH_LTO` / `BUILD_WITH_GC_SECTIONS` /
`BUILDTYPE=MinSizeRel`:

```bash
BUILD_WITH_OZ=ON make                  # Clang -Oz aggressive size for MinSizeRel (Clang only)
BUILD_WITH_HIDDEN_VISIBILITY=ON make   # Hide non-exported symbols (-fvisibility=hidden)
BUILD_WITH_ICF=ON make                 # Fold identical functions at link (lld/gold; not macOS)
BUILD_WITH_NO_OUTLINE=ON make          # Disable Clang's AArch64 machine outliner (bigger, faster)
BUILD_WITH_REPRODUCIBLE_PATHS=ON make  # Remap __FILE__/debug paths (no absolute source paths)
BUILD_WITH_HARDENING=ON make           # Stack protector, zero-init, FORTIFY, arm64 PAC/BTI
# BUILD_WITH_COMPRESSED_BYTECODE=ON    # Deflate embedded bytecode -- REQUIRES `make js TJSC_COMPRESS=-z`
# BUILD_WITH_NO_UNWIND_TABLES=ON       # EXPERIMENTAL: drops async backtraces; verify before use
```

`BUILD_WITH_COMPRESSED_BYTECODE` and `tjsc -z` encode/decode the same format and must be set
together; enabling one alone makes the loader inflate garbage. `BUILD_WITH_HIDDEN_VISIBILITY`,
`BUILD_WITH_REPRODUCIBLE_PATHS`, `BUILD_WITH_HARDENING` and `BUILD_WITH_NO_UNWIND_TABLES` are
all `NOT MSVC`-guarded — they are silently no-ops on an MSVC build.

`BUILD_WITH_OZ` requires Clang and only affects `MinSizeRel` (it rewrites `-Os` to `-Oz` in the
MinSizeRel flag strings; no-op for other build types and a warning under GCC). `BUILD_WITH_ICF`
needs lld or gold and is skipped on Apple ld64 (which already gets `-Wl,-dead_strip` from
`BUILD_WITH_GC_SECTIONS`); it folds at `--icf=safe`. `BUILD_WITH_NO_UNWIND_TABLES`
is experimental — it drops async unwind/`.eh_frame` tables (breaks signal/crash backtraces) while keeping
C++ exception unwinding; leave it OFF unless you've verified your signal/error paths.

`BUILD_WITH_NO_OUTLINE` is the size/speed dial that matters on arm64, and it is **two** flags, not
one. Clang's machine outliner is on by default at `-Oz`; it rips repeated sequences out of QuickJS's
interpreter dispatch loop, which measured here (macOS arm64, `min`) costs 30% of run time to save
4% of the binary. The compile-time `-mno-outline` alone is a *silent no-op under LTO* — `-flto=thin`
runs codegen at the link — so the option also adds `-Wl,-mllvm,-enable-machine-outliner=never` to
`tjs-cli`. Both halves probe first and warn rather than fail on GCC (no outliner) or bfd ld.

## Testing a slim / dist binary

The published profiles have `tjs test` compiled out, so they cannot drive the suite
themselves — but `tjs run` is kept in all of them, which is what actually executes each
test file. `TJS_TEST_EXE` therefore lets a full-CLI build run the loop while the shipped
artifact runs every test:

```bash
TJS_TEST_EXE=$(pwd)/dist/min/tjs ./build/tjs test tests/   # or: mise run test:dist -- min
mise run test:dist:all                                     # all eight published profiles
```

The skip filter probes `TJS_TEST_EXE` for its own `tjs.engine.features` *and* `tjs.engine.cli`
before the loop, so tests are gated on the binary *under test*, not on the host. A probe that
cannot run, prints nothing, or reports fewer keys than the host is a hard error — never a silent
pass.

Three black-box tests assert against the binary's own feature vector rather than a fixed
expectation, so they are meaningful on every profile and need no `feature-skip.json` entry:
`test-cli-gating.js` (a subcommand is reachable iff `tjs.engine.cli` says so),
`test-builtin-module-gating.js` (a `tjs:` module is importable iff its feature is on) and
`test-test-exe-override.js` (the suite really is running inside `TJS_TEST_EXE`).

Some tests dlopen a fixture library built next to `tjs` (`libffi-test`, `libsqlite-test`),
looked up under `./build` by default. Set **`TJS_TEST_LIBDIR`** when the driver lives elsewhere
— without it those tests fail loudly rather than skipping. `scripts/build-dist.mjs --host-tjs`
builds a driver plus those fixtures into `--host-dir` (default `build-host`) as part of a dist
build, which is how CI gets one. `libsqlite-test` only exists inside CMakeLists.txt's
`if(BUILD_WITH_SQLITE)`, so `--host-tjs` turns SQLite on in the *host* tree for the SQLite
profiles even though the driver itself never uses it:

```bash
TJS_TEST_EXE=$(pwd)/dist/min/tjs TJS_TEST_LIBDIR=./build-host ./build-host/tjs test tests/
```

Never point `--host-dir` at your `./build`: it configures a feature-reduced tree, and `make`
only passes `BUILDTYPE`/`MIMALLOC`, so the cached options would silently survive into your next
normal build.

### CLI gating in `feature-skip.json`

The `feature-skip.json` mechanism described above also gates tests that spawn a CLI subcommand
which slim builds compile out. The entry point publishes its esbuild `--define` gating as its own
frozen `tjs.engine.cli` — `eval`, `serve`, `bundler`, `testRunner`, `compile`, `app`, `help`,
`tlsCa` — and `feature-skip.json` keys on those under a `cli.` prefix (`"cli.eval"`,
`"cli.bundler"`, …) alongside the plain CMake feature keys. Prefer splitting a test that only
*partly* needs a gated subcommand (see `test-cli-help.js` vs `test-cli-version.js`) over skipping
the whole file.

It is a separate object, not extra keys on `tjs.engine.features`, so that `src/js/core/engine.js`
stays byte-identical to upstream and `features` keeps upstream's invariant of being frozen at
construction. `tjs.engine` is extensible, which is what makes this possible; a Worker never
evaluates `run-main`, so `tjs.engine.cli` is simply `undefined` there.

## Generated bundles are tracked here

Corrects "Generated files live in `src/bundles/` (git-ignored)" above: the two halves of
`src/bundles/` differ in this fork. `src/bundles/js/` is git-ignored (intermediate esbuild
output), but **`src/bundles/c/` is tracked** — the generated C arrays are committed, and CI's
`codegen` job fails if `make js` produces anything different. Any tool that regenerates bundles
with non-default settings (compression, CLI gating) must restore them afterwards or it dirties
the tree.

## Syncing with upstream

**Run `sh scripts/setup-repo.sh` once per clone.** It registers the `keep-ours` merge driver
that `.gitattributes` names for `src/bundles/c/**` and `src/cacert.c`. Git ignores merge drivers
defined in tracked config (a driver is arbitrary code), so a fresh clone has no idea what
`merge=keep-ours` means and falls back to a normal text merge.

That fallback is the one failure mode here that is *silent*. Those files are QuickJS bytecode
byte-arrays and a compressed CA blob; a three-way text merge of either produces output valid for
neither side, and git cannot tell. Nothing is lost by keeping ours: the bundles are pure
functions of `src/js/**`, which merges normally, and are regenerated from the merged sources.

```bash
mise run sync:upstream   # setup-repo, tag a rollback point, merge, then `make js`
mise run sync:regen      # re-run just the regeneration after a manual conflict fix
```

The order matters and is easy to get wrong: **`make js` reads `src/js/**`, so it must run after
the last conflict there is resolved**, and its output belongs in the merge commit. CI's `codegen`
job fails if you skip it, but only after the push.

Note the driver only fires on modify/modify. A bundle file upstream changed and this fork did not
merges trivially without ever consulting it.

### The daily chain

Four scheduled workflows, in order. Each recomputes what it needs — workflow outputs do not
cross runs, and a stale answer is worse than a spare `git merge --no-commit`. Every one of them
runs `sh scripts/setup-repo.sh` first, for the reason above.

| cron (UTC) | workflow | does | on failure |
| --- | --- | --- | --- |
| 04:30 | `sync-upstream.yml` | fast-forwards `master` via the REST merge-upstream endpoint, which refuses to act on a diverged branch | warns |
| 05:47 | `merge-check.yml` | dry-runs the merge into `slim`; owns the single reused `upstream-merge` issue | annotates |
| 06:15 | `auto-merge-pr.yml` | opens `chore/upstream-merge-<date>` when the dry-run is clean. A human clicks merge | notice |
| 07:00 | `upstream-release.yml` | publishes `slim-vX.Y.Z-N` once upstream releases `vX.Y.Z` and `slim` contains it | notice |

Nothing in the chain ever pushes to `slim`; every merge is offered as a PR. Schedules routinely
lag 15–30 minutes here, which the ordering tolerates but does not guarantee — `upstream-release`
stands down when an `auto-merge-pr` proposal is still open, and vice versa.

Both branch-pushing steps also stand down when the merge touches `.github/workflows/**`, and say
so with a notice. This is not a bug to fix by retrying: `workflows` is not one of the permissions
a `GITHUB_TOKEN` can be granted — there is no such key — so the push is rejected outright
(`refusing to allow a GitHub App to create or update workflow ...`), and it is rejected *after*
the merge and `make js` have already run. Upstream's dependabot bumps its workflow actions
regularly, so this fires often; merge those locally with `mise run sync:upstream`. Lifting the
restriction means a PAT or GitHub App token with workflow scope, which is a deliberate decision to
put a long-lived push credential in the repo, not a config tweak.

`upstream-release` polls, because GitHub does not deliver another repository's `release` event.
Its state is the set of published `slim-vX.Y.Z-*` tags, not a committed last-seen file that could
disagree. The common path is a no-op: by the time upstream tags, those commits have usually been
on `slim` for days, so it only has to tag. Three things gate a publish — the merged
`TJS__VERSION_*` must equal the released version (the one hard error; the rest exit 0 with a
notice), `verify.yml` must have concluded `success` on that exact sha, and `slim` must not have
moved during the run.

It publishes by dispatching `dist.yml`, **not** by pushing the tag: a push made with
`GITHUB_TOKEN` does not start a workflow run, so the tag would sit there and `dist.yml` would
never fire. `workflow_dispatch` is one of the two documented exceptions, which is what keeps this
working without a PAT.

## Submodules are patched in place

`CMakeLists.txt`'s `tjs_apply_patches(<submodule> <prefix>)` globs `patches/<prefix>*.patch`
and applies each to the submodule work tree at configure time. It is idempotent — forward
`git apply --check`, else reverse-check — and a state that is neither is a `FATAL_ERROR`, not
a silent skip. Two call sites today:

- `mbedtls-` → `patches/mbedtls-quic.patch`, QUIC support upstream mbedTLS lacks (from
  warmcat's mbedTLS QUIC branch). Leaves `deps/mbedtls` permanently showing ~11 modified files.
- `lws-` → `patches/lws-mbedtls-client-alpn-uaf.patch`, a stack-use-after-scope on the
  HTTP/3→TCP fallback path (warmcat/libwebsockets#3658).

`.gitmodules` sets `ignore = dirty` on both so `git status` stays quiet. Do not commit or
revert those edits. If configure reports a patch "neither applies nor is already applied"
(e.g. after bumping the submodule), reset with `git -C deps/<name> checkout .`. Each patch is
upstreamed — delete the file once the submodule is bumped past its merge, and the call too
once no patch shares its prefix.

## Distribution builds (CI)

`scripts/build-dist.mjs` is a dependency-free Node driver that produces the slim distributed
binary on Linux, macOS and Windows; `.github/workflows/dist.yml` runs it as a 4-way matrix. It
reimplements the bundle pipeline in Node rather than using `make`, because the Makefile is
GNU-make with POSIX-shell recipes and cannot run on a Windows runner. `make`/`mise` remain the
local-development path. Its output is byte-identical to
`make -B core stdlib RUN_MAIN_DEFINES="…" TJSC_COMPRESS=-z`; keep it that way when changing
either side. On MSVC six of the size/hardening levers are compiled out, so the Windows artifact
is deliberately built and named as a different, non-hardened profile.

Two workflows gate the slim builds, both running the *shipped* binary through the whole suite:

- `.github/workflows/verify.yml` — every push/PR on `slim`, Linux only, the 6 *feature* profiles.
  The fast per-merge signal. The two alternative-codegen profiles are deliberately not here: on
  Linux/GCC they differ from `min` only in LTO, so they would cost two jobs to re-test the same
  binary. `dist.yml` still runs the whole suite on them before anything is published.
- `.github/workflows/dist.yml` — 8 profiles × 4 platforms (the six feature profiles, plus
  `tuned-min` and `balanced-min`, which are the `min` feature set at a different codegen
  mode); the `release` job `needs: build`, so
  a profile whose suite fails is never published.

`dist.yml`'s matrix is fronted by a `gate` job. `on.pull_request` is deliberately unfiltered
there: GitHub ANDs `paths` with `types`, so a `labeled` event on a PR touching none of those
paths never starts the workflow at all. `gate` therefore re-implements the path filter against
`pulls/{n}/files`, and short-circuits to "run" on the `auto-release` label. Note a *skipped*
required check counts as a pass in branch protection, so dropping that label from a release PR
silently bypasses the four-platform signal.

`gate` also emits **both matrix axes** as JSON, which is what lets a PR run 8 jobs where a tag runs
32. A tag, a dispatch or an `auto-release` PR gets the full 8 profiles × 4 platforms; an ordinary
build-affecting PR gets 4 profiles (`min`, `ffi-tls-sqlite`, `tuned-min`, `balanced-min` — floor,
ceiling and both codegen modes) × macOS + Windows only. The Linux half is dropped because
`verify.yml` already builds and tests all six feature profiles on Linux for every push; what it
cannot cover is Apple clang (the only toolchain that actually gets `-Oz` and the machine outliner)
and MSVC. The four middle profiles are feature unions of the two endpoints. The consequence to
keep in mind: a Linux-only regression in `build-dist.mjs` now surfaces in `verify.yml`, not here.

Both build with `--host-tjs` (driver + fixtures into `build-host`) and then run the suite with
`TJS_TEST_EXE` and `TJS_TEST_LIBDIR` pointed at the artifact and that tree. The feature vector (`wasm`, `sqlite`,
`webcrypto`, `ffi`, `tls`, `bundledCa`) is asserted by the smoke test *inside* `build-dist.mjs`,
so a silently flipped CMake default fails at build time rather than as a confusing test failure.
Read the job summary's SKIP count, not just the FAIL count: a profile can go green by skipping
too much.

## clang-format 18 is the reference version

`make format` (upstream's target) runs whatever `clang-format` is on PATH. CI's Lint job pins
`ubuntu-24.04` and installs the distro package — **clang-format 18** — then fails on a dirty tree,
so 18 is the arbiter. A newer local formatter (Homebrew currently ships 22) reformats files that
18 then wants back, and the resulting red Lint **cannot be reproduced locally**: re-running
`clang-format -i src/mod_ffi.c` on the v22 machine is a no-op.

Use `mise run format`, not `make format`. It resolves `$CLANG_FORMAT`, then `clang-format-18`,
then `clang-format`, and refuses to run at all unless the major version is 18. Do not pin the
version in `.github/workflows/ci.yml` — that file is upstream-owned and the pin belongs on our
side of the split.

## The one deliberate fork edit inside `ci.yml`

`ci.yml` is upstream-owned and the fork's delta there is exactly one block: extra `paths-ignore`
entries, marked with a `Fork-only additions below this line` comment. Everything listed is a file
that cannot change what a default `make` produces — docs, `mise.toml`, `benchmarks/**`, the
fork-owned workflows, `cmake/slim.cmake` and `scripts/build-dist.mjs`. It takes a tooling-only PR
from ~25 minutes of CI to ~8. `slim.mk` is deliberately **not** in the list: `make js` includes it,
so it can break the `Codegen` job.

## Required status checks must come from an unfiltered workflow

GitHub reports **no check at all** for a workflow that path filtering skipped. A required context
that never reports leaves the PR permanently "Expected" and unmergeable through the normal button.
That rule is what shapes the whole check layout here:

| workflow | filtered? | provides |
| --- | --- | --- |
| `required.yml` (fork-owned) | **never** — do not add one | `lint`, `codegen` — required |
| `verify.yml` (fork-owned) | **never** — filter removed for this reason | the six profile names — required |
| `ci.yml` (upstream) | yes, incl. fork-only paths | `Lint`, `Codegen` and 34 others — all advisory |

`required.yml` duplicates upstream's `Lint`/`Codegen` steps rather than reusing them, because
`ci.yml` is path-filtered and cannot host a required context. Both jobs are ~2 minutes, which is
what makes paying for them twice acceptable. **Nothing detects drift** between the two copies: if
upstream changes how it lints or regenerates bundles, `required.yml` has to be updated by hand.

`verify.yml` carried **two** filters and both hit this. `paths-ignore: website/**, types/**,
**/*.md` meant a docs-only PR could not be merged at all; `branches: [ slim ]` on the
`pull_request` trigger meant a *stacked* PR could not either, since a PR based on another feature
branch is not a PR "to slim" and the six contexts simply never appeared. Retargeting such a PR
afterwards does not help — `edited` is not one of the events that starts a workflow, so the checks
still never run. Close and reopen it, which fires `reopened`.

Running six profile jobs on a typo fix is the cheaper mistake. The `push` trigger keeps its branch
filter: pushes to a feature branch are already covered by that branch's PR.

See `.claude/plans/2026-08-21_ci-speedup.md`.
