#!/usr/bin/env node
// Portable, dependency-free build driver for the distributed slim `tjs` binary.
//
// Replaces the `mise run dist-*` recipes (GNU make + POSIX shell) with plain
// Node so the same code path runs on Linux, macOS and Windows CI runners.
// `make`/`mise` stay for local development.
//
// See .claude/plans/archive/2026-08-08_ci-portable-build-script.md.
//
//   node scripts/build-dist.mjs                 # build the current checkout
//   node scripts/build-dist.mjs --profile tls   # pick a feature set
//   node scripts/build-dist.mjs --profile min --optimization balanced
//   node scripts/build-dist.mjs --profile min --optimization tuned
//   node scripts/build-dist.mjs --bundles-only  # regenerate src/bundles only
//   node scripts/build-dist.mjs --ref v26.6.0   # clone the fork at a ref first
//
// Requires: Node >= 20, git, cmake, a C/C++ toolchain, and `npm install` run
// (esbuild is resolved from node_modules, never from the network).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Profile definition
// ---------------------------------------------------------------------------

// The published feature sets. Everything else (WASM, mimalloc, most CLI
// subcommands) is off in all of them; these differ only in FFI, TLS and SQLite,
// the three features that cost real size. Each maps 1:1 onto a `dist:*` mise
// task and onto a `slim-<key>-v*` release tag.
//
// Deliberately not the full 2^3: the profile count multiplies straight into
// dist.yml's platform matrix. SQLite gets the floor (`sqlite`) and the widest
// (`ffi-tls-sqlite`); the four combinations in between are a local build away.
const PROFILES = {
    min: { ffi: false, tls: false, sqlite: false },
    ffi: { ffi: true, tls: false, sqlite: false },
    tls: { ffi: false, tls: true, sqlite: false },
    sqlite: { ffi: false, tls: false, sqlite: true },
    'ffi-tls': { ffi: true, tls: true, sqlite: false },
    'ffi-tls-sqlite': { ffi: true, tls: true, sqlite: true },
};

// Codegen modes, largest-and-fastest last. All three start from MinSizeRel; they
// differ in how much of the -Oz slowdown they buy back, and where.
//
//   smallest  -Oz + LTO everywhere.
//   tuned     smallest with Clang's AArch64 machine outliner switched off.
//   balanced  smallest with deps/quickjs raised back to -Os (BUILD_WITH_QJS_SPEED).
//
// Measured on darwin-arm64, `min`, against smallest: tuned is +4.1% size for -27%
// run time, balanced +6.7% for -41%. `balanced` implies tuned's win rather than
// stacking with it -- the outliner only runs on functions marked `minsize`, which
// -Os does not set, so raising QuickJS to -Os already takes the interpreter out of
// its reach. Setting both measured 32,688 B larger than balanced alone at
// identical run time, which is why BUILD_WITH_NO_OUTLINE is not part of it.
//
// -Oz and the outliner are both Clang-only, so on the GCC and MSVC runners all
// three modes collapse onto -Os/O1 + LTO and produce the same binary.
const OPTIMIZATIONS = [ 'smallest', 'tuned', 'balanced' ];

// The REPL has two halves that must agree -- the run-main bundle define and the
// CMake option that drops run-repl.c and core.runRepl. One constant drives both
// so they cannot be flipped independently. See cmake/slim.cmake.
const REPL = true;

// CLI subcommand gating, applied to the run-main bundle via esbuild --define.
// esbuild's dead-code elimination then drops the gated-out subcommands.
function slimDefines(features) {
    return [
        // Kept on in every published profile: an interactive `tjs` with no REPL
        // is a surprising thing to ship, and the ~16.6 KB it costs is the one
        // saving here that changes what the binary is *for*. Flipping it means
        // flipping BUILD_WITH_REPL below in the same edit.
        `--define:__TJS_REPL__=${REPL}`,
        '--define:__TJS_EVAL__=false',
        '--define:__TJS_SERVE__=false',
        '--define:__TJS_BUNDLER__=false',
        '--define:__TJS_TEST_RUNNER__=false',
        '--define:__TJS_COMPILE__=true',
        '--define:__TJS_APP__=false',
        '--define:__TJS_HELP__=false',
        // --tls-ca is only useful on a TLS build; on the others the option and
        // the vm.c CA setter behind it are compiled out.
        `--define:__TJS_TLS_CA__=${features.tls}`,
    ];
}

// Polyfill gating. XHR stays ON: dropping it saves ~16 KB but removes
// XMLHttpRequest, which the named profile keeps (and the measured macOS
// baseline below assumes).
const POLYFILLS_DEFINES = [ '--define:__TJS_XHR__=true' ];

const ESBUILD_COMMON = [
    '--target=esnext',
    '--platform=neutral',
    '--format=esm',
    '--main-fields=main,module',
];
const ESBUILD_MINIFY = [ '--minify', '--keep-names' ];

// Every published profile, measured per platform from the green dist.yml run on
// 2026-08-24 at slim-v26.6.0-8 (32 cells, all suites passing) by unzipping the
// release artifacts and stat'ing the binary.
//
// tuned-min matching min exactly on linux-x64, linux-arm64 and win32-x64 is not
// a copy-paste error: -Oz and the machine outliner are Clang-only, and those
// three legs build with GCC or MSVC, so "min with the outliner off" is min.
//
// The four balanced-min numbers predate the recipe change from "-Os, no LTO" to
// "-Oz + LTO with QuickJS at -Os" and are therefore too HIGH on every platform:
// on darwin-arm64 by ~80 KB, and on the GCC/MSVC legs by the whole LTO delta,
// since balanced now produces the same binary as min there. Deliberately left
// alone rather than guessed at: the gate only trips on a binary that is *over*
// its budget, so a stale-high baseline is slack, never a false failure, and these
// are refreshed from the release artifacts after the next green dist.yml run.
//
// A single number per profile does not survive contact with four platforms: the
// spread across them is larger than the spread across profiles. linux-arm64 is
// ~265 KB above linux-x64 on the same profile (arm64 PAC/BTI prologues are not
// free) and MSVC, which compiles nine of the eleven size/hardening levers out, is
// another ~240 KB above that. Every one of these numbers on the old flat 2 MiB
// budget would have failed for linux-arm64 the moment --enforce-size was turned on.
const MEASURED = {
    'linux-x64': {
        min: 1914824, ffi: 1964424, tls: 2365536,
        'ffi-tls': 2406944, sqlite: 2717208, 'ffi-tls-sqlite': 3209344,
        'tuned-min': 1914824, 'balanced-min': 1947800,
    },
    'linux-arm64': {
        min: 2184240, ffi: 2250080, tls: 2708656,
        'ffi-tls': 2708960, sqlite: 3183016, 'ffi-tls-sqlite': 3707736,
        'tuned-min': 2184240, 'balanced-min': 2250048,
    },
    'darwin-arm64': {
        min: 2008960, ffi: 2059776, tls: 2506016,
        'ffi-tls': 2540336, sqlite: 2939072, 'ffi-tls-sqlite': 3486960,
        'tuned-min': 2057712, 'balanced-min': 2189088,
    },
    'win32-x64': {
        min: 2421760, ffi: 2486784, tls: 2925056,
        'ffi-tls': 2990080, sqlite: 3246592, 'ffi-tls-sqlite': 3814400,
        'tuned-min': 2421760, 'balanced-min': 2437120,
    },
};

// Headroom over the measured size before the gate trips. Wide enough that a
// compiler or dependency bump does not fail a release on noise, tight enough to
// catch the class of regression that matters: the h3/QUIC + QuickJS merge that
// cost ~99 KB in one go would still be caught on every profile.
const SIZE_HEADROOM = 1.05;

// Fallback for platforms with no measurement yet (darwin-x64, Alpine, Android
// and anything cross-built). Same shape as before: a flat per-platform budget
// plus a per-profile adjustment for the TLS profiles, where mbedtls and the
// compressed CA bundle are the expensive part.
const FALLBACK_BUDGETS = {
    'darwin-arm64': 2097152,
    'darwin-x64': 2097152,
    'linux-x64': 2097152,
    'linux-arm64': 2097152,
    'win32-x64': 3145728,
};

// Every profile is measured on all four shipped platforms now, so this path is
// only reached by darwin-x64, Alpine, Android and cross-builds. Each delta
// covers the largest over-`min` cost that profile showed across the four, since
// this branch adds the delta to a flat budget WITHOUT applying SIZE_HEADROOM:
//
//   ffi  +65,840   tls +524,416   ffi-tls +564,736   (worst: linux-arm64 / win32-x64)
//   sqlite +998,776   ffi-tls-sqlite +1,523,496   (worst: linux-arm64)
//
// SQLite is the most expensive optional feature by a distance -- ~875 KB on
// darwin-arm64, more than TLS plus the bundled CA together.
const FALLBACK_PROFILE_DELTA = {
    min: 0,
    ffi: 98304,
    tls: 589824,
    'ffi-tls': 589824,
    sqlite: 1048576,
    'ffi-tls-sqlite': 1572864,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

function log(msg) {
    process.stdout.write(`==> ${msg}\n`);
}

// Restores src/bundles; installed once the snapshot exists. process.exit() does
// not unwind, so every exit path has to call this explicitly -- a failed build
// or size gate must not leave a developer's tree holding slim bundles.
let cleanup = null;

function fail(msg) {
    process.stderr.write(`error: ${msg}\n`);

    try {
        cleanup?.();
    } catch (e) {
        process.stderr.write(`error: cleanup failed: ${e.message}\n`);
    }

    process.exit(1);
}

for (const sig of [ 'SIGINT', 'SIGTERM' ]) {
    process.on(sig, () => {
        cleanup?.();
        process.exit(130);
    });
}

// Every child process is spawned without a shell: quoting rules differ between
// sh/cmd/PowerShell and CMAKE_C_FLAGS is a single argument containing a space.
function run(cmd, args, opts = {}) {
    const shown = [ cmd, ...args ].map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

    if (opts.verbose !== false) {
        process.stdout.write(`    $ ${shown}\n`);
    }

    const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });

    if (res.error) {
        fail(`failed to spawn ${cmd}: ${res.error.message}`);
    }

    if (res.status !== 0) {
        fail(`command failed (exit ${res.status}): ${shown}`);
    }

    return res;
}

function capture(cmd, args, opts = {}) {
    const res = spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });

    if (res.error || res.status !== 0) {
        return null;
    }

    return res.stdout.trim();
}

function have(cmd) {
    return capture(cmd, [ '--version' ]) !== null;
}

function rmrf(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

// Overwriting an existing executable in place is not safe on macOS arm64: the
// kernel caches the code-signature verdict per vnode, so a rebuilt binary
// written over the previous one is SIGKILLed on exec ("Killed: 9") even though
// its own ad-hoc signature is valid. Unlinking first gives it a fresh inode.
function copyExecutable(src, dest) {
    fs.rmSync(dest, { force: true });
    fs.copyFileSync(src, dest);
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fmtBytes(n) {
    return `${n.toLocaleString('en-US')} B (${(n / 1024 / 1024).toFixed(2)} MiB)`;
}

// ---------------------------------------------------------------------------
// Phase 0 -- arguments & environment
// ---------------------------------------------------------------------------

const { values: opts } = parseArgs({
    options: {
        profile: { type: 'string', default: 'ffi' },
        optimization: { type: 'string', default: 'smallest' },
        ref: { type: 'string' },
        repo: { type: 'string', default: 'https://github.com/lukasMega/txiki.js-with-slim-builds.git' },
        workdir: { type: 'string' },
        'build-dir': { type: 'string', default: 'build-dist' },
        'host-dir': { type: 'string', default: 'build-host' },
        out: { type: 'string', default: 'dist' },
        'max-size': { type: 'string' },
        'expect-size': { type: 'string' },
        'enforce-size': { type: 'boolean', default: false },
        'cmake-arg': { type: 'string', multiple: true, default: [] },
        jobs: { type: 'string' },
        'bundles-only': { type: 'boolean', default: false },
        'keep-bundles': { type: 'boolean', default: false },
        'skip-smoke': { type: 'boolean', default: false },
        'host-tjs': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
    },
});

if (opts.help) {
    process.stdout.write(`Usage: node scripts/build-dist.mjs [options]

  --profile <name>      Feature set to build: ${Object.keys(PROFILES).join(', ')}
                        (default: ffi). They differ only in FFI, TLS and SQLite.
  --optimization <name> Code-size mode: ${OPTIMIZATIONS.join(', ')}
                        (default: smallest). Smallest keeps -Oz plus LTO where
                        supported; tuned is smallest with Clang's AArch64
                        machine outliner disabled (~+4% size, ~-27% run time);
                        balanced is smallest with deps/quickjs raised to -Os
                        (~+7% size, ~-41% run time).
  --ref <git-ref>       Clone --repo at this ref into --workdir and build that
                        instead of the current checkout.
  --repo <url>          Repository to clone (default: our fork).
  --workdir <dir>       Clone destination (default: a temp dir).
  --build-dir <dir>     CMake binary dir for tjs (default: build-dist).
  --host-dir <dir>      CMake binary dir for the host tjsc (default: build-host).
                        Reconfigures the directory with a reduced feature set,
                        so do not point it at a working build tree: \`make\` only
                        passes BUILDTYPE and MIMALLOC and would not undo it.
  --out <dir>           Artifact output dir (default: dist).
  --max-size <bytes>    Size budget (default: per-platform table).
  --expect-size <bytes> Assert an exact byte size (bundle/flag parity check).
  --enforce-size        Fail when the binary exceeds the budget. Off by default:
                        the first runs only report sizes so real per-platform
                        numbers can be recorded.
  --cmake-arg <arg>     Extra -D... passed to the tjs configure step (repeatable,
                        e.g. the vcpkg toolchain file on Windows).
  --jobs <n>            Parallel build jobs.
  --bundles-only        Stop after regenerating src/bundles (parity testing).
  --keep-bundles        Do not restore src/bundles afterwards. src/bundles/c is
                        tracked in git; without this the tree is left untouched.
  --skip-smoke          Skip the runtime smoke test.
  --host-tjs            Also build the full-CLI host \`tjs\` (and the test fixture
                        libraries) in --host-dir. That binary is what drives
                        \`tjs test tests/\` against the slim artifact via
                        TJS_TEST_EXE -- the artifact cannot, its test runner is
                        compiled out.
`);
    process.exit(0);
}

const features = PROFILES[opts.profile];

if (!features) {
    fail(`unknown --profile ${JSON.stringify(opts.profile)}; `
        + `expected one of: ${Object.keys(PROFILES).join(', ')}`);
}

if (!OPTIMIZATIONS.includes(opts.optimization)) {
    fail(`unknown --optimization ${JSON.stringify(opts.optimization)}; `
        + `expected one of: ${OPTIMIZATIONS.join(', ')}`);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);

if (nodeMajor < 20) {
    fail(`Node >= 20 required, found ${process.versions.node}`);
}

for (const tool of [ 'git', 'cmake' ]) {
    if (!have(tool)) {
        fail(`\`${tool}\` not found in PATH`);
    }
}

const jobs = Number(opts.jobs) || os.availableParallelism?.() || os.cpus().length || 4;

// Repo root: the parent of scripts/, unless we clone.
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let root = scriptRoot;

if (opts.ref) {
    const dest = path.resolve(opts.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-dist-')));

    // Resolve the ref before cloning: otherwise a typo only surfaces after the
    // shallow clone fails and the full-clone fallback has pulled every submodule.
    if (!/^[0-9a-f]{7,40}$/.test(opts.ref)
        && capture('git', [ 'ls-remote', '--exit-code', opts.repo, opts.ref ]) === null) {
        fail(`ref ${JSON.stringify(opts.ref)} not found in ${opts.repo}`);
    }

    log(`cloning ${opts.repo} @ ${opts.ref} into ${dest}`);
    rmrf(dest);

    const shallow = [ 'clone', '--depth=1', '--branch', opts.ref, '--recursive',
        '--shallow-submodules', opts.repo, dest ];
    const res = spawnSync('git', shallow, { stdio: 'inherit', shell: false });

    if (res.status !== 0) {
        // Some submodule servers refuse shallow fetches; fall back to a full clone.
        log('shallow clone failed, retrying with a full clone');
        rmrf(dest);
        run('git', [ 'clone', '--recursive', opts.repo, dest ]);
        run('git', [ '-C', dest, 'checkout', opts.ref ]);
        run('git', [ '-C', dest, 'submodule', 'update', '--init', '--recursive' ]);
    }

    root = dest;
}

const abs = (...p) => path.join(root, ...p);

if (!fs.existsSync(abs('CMakeLists.txt'))) {
    fail(`${root} does not look like a txiki.js checkout`);
}

// esbuild must come from node_modules: `npx esbuild` hits the network per run
// and is version-unstable, which silently changes the bundles (and the size).
let esbuildBin = abs('node_modules', 'esbuild', 'bin', 'esbuild');

if (!fs.existsSync(esbuildBin)) {
    try {
        esbuildBin = path.join(path.dirname(require.resolve('esbuild', { paths: [ root ] })),
            '..', 'bin', 'esbuild');
    } catch {
        esbuildBin = null;
    }
}

if (!esbuildBin || !fs.existsSync(esbuildBin)) {
    fail(`esbuild not found under ${root}/node_modules -- run \`npm install\` first`);
}

// Depending on the platform, node_modules/esbuild/bin/esbuild is either the
// native executable itself or a `#!/usr/bin/env node` shim that execs it.
const esbuildIsScript = fs.readFileSync(esbuildBin).subarray(0, 2).toString('latin1') === '#!';
const esbuild = args => (esbuildIsScript
    ? run(process.execPath, [ esbuildBin, ...args ], { cwd: root })
    : run(esbuildBin, args, { cwd: root }));

const platformKey = `${process.platform}-${process.arch}`;

log(`repo:      ${root}`);
log(`platform:  ${platformKey}`);
log(`jobs:      ${jobs}`);

// ---------------------------------------------------------------------------
// Phase 1 -- host tjsc
// ---------------------------------------------------------------------------

// Single- and multi-config generators disagree on where an executable lands:
// Ninja/Make put it at <dir>/<name>, Visual Studio at <dir>/<config>/<name>.
// Probe, never assume.
function findBuilt(dir, name, config) {
    return [
        path.join(dir, name),
        path.join(dir, `${name}.exe`),
        path.join(dir, config, name),
        path.join(dir, config, `${name}.exe`),
    ].find(p => fs.existsSync(p)) ?? null;
}

// tjsc is a build artifact that must exist *before* the bundles it compiles.
// It is kept in its own tree so a future cross-build can produce a host tjsc
// and a target tjs from the same source.
function buildHostTjsc() {
    const dir = path.resolve(root, opts['host-dir']);

    log(`building host tjsc in ${dir}`);
    run('cmake', [
        '-B', dir,
        '-S', root,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DBUILD_WITH_WASM=OFF',
        // tjsc alone never needs SQLite. --host-tjs does: it builds this tree's
        // default target for the test fixtures, and CMakeLists.txt only defines
        // the `sqlite-test` shared library (which tests/test-sqlite.js
        // loadExtension()s out of TJS_TEST_LIBDIR) inside `if(BUILD_WITH_SQLITE)`.
        // Without it the sqlite tests fail loudly on a `sqlite` profile instead
        // of running.
        `-DBUILD_WITH_SQLITE=${opts['host-tjs'] && features.sqlite ? 'ON' : 'OFF'}`,
        '-DBUILD_WITH_TLS=OFF',
        '-DBUILD_WITH_FFI=OFF',
        '-DBUILD_WITH_MIMALLOC=OFF',
        ...opts['cmake-arg'],
    ], { cwd: root });
    run('cmake', [ '--build', dir, '--config', 'Release', '--target', 'tjsc',
        '--parallel', String(jobs) ], { cwd: root });

    const found = findBuilt(dir, 'tjsc', 'Release');

    if (!found) {
        fail(`tjsc not found after building in ${dir}`);
    }

    log(`host tjsc: ${found}`);

    return { tjsc: found, dir };
}

// The full-CLI `tjs` from the same host tree. Its only job is to *drive* the
// suite against the slim artifact (`TJS_TEST_EXE=dist/tjs host-tjs test tests/`),
// which the artifact cannot do for itself: every profile compiles its test
// runner out. Reusing the already-configured host tree costs one more target
// instead of a third CMake tree, and it must happen before generateBundles()
// replaces src/bundles with the slim, compressed ones.
//
// Builds the default target rather than just `tjs-cli`, because that also
// produces the ffi-test/sqlite-test fixture libraries the suite dlopens. Point
// the suite at them with TJS_TEST_LIBDIR=<host-dir>; they default to ./build.
function buildHostTjs(dir) {
    log(`building host tjs (full CLI) in ${dir}`);
    run('cmake', [ '--build', dir, '--config', 'Release', '--parallel', String(jobs) ],
        { cwd: root });

    const found = findBuilt(dir, 'tjs', 'Release');

    if (!found) {
        fail(`host tjs not found after building in ${dir}`);
    }

    // Publish it at one predictable path so callers need not know which
    // generator CMake picked.
    const dest = path.join(dir, isWindows ? 'tjs.exe' : 'tjs');

    if (path.resolve(found) !== path.resolve(dest)) {
        copyExecutable(found, dest);
    }

    log(`host tjs:  ${dest}`);

    return dest;
}

// ---------------------------------------------------------------------------
// Phase 2 -- bundles (replaces `make js`)
// ---------------------------------------------------------------------------

// Mirrors the Makefile rules. The stdlib list is derived from the source tree so
// a newly added stdlib module cannot be silently dropped.
function bundleSpecs() {
    const specs = [
        {
            entry: 'src/js/polyfills/index.js',
            js: 'src/bundles/js/core/polyfills.js',
            c: 'src/bundles/c/core/polyfills.c',
            module: 'tjs:internal/polyfills',
            prefix: 'tjs__',
            metafile: true,
            extra: [ '--minify-syntax', ...POLYFILLS_DEFINES ],
        },
        {
            entry: 'src/js/core/index.js',
            js: 'src/bundles/js/core/core.js',
            c: 'src/bundles/c/core/core.c',
            module: 'tjs:internal/bootstrap',
            prefix: 'tjs__',
            metafile: true,
            extra: [],
        },
        {
            entry: 'src/js/run-main/index.js',
            js: 'src/bundles/js/core/run-main.js',
            c: 'src/bundles/c/core/run-main.c',
            module: 'tjs:internal/run-main',
            prefix: 'tjs__',
            metafile: true,
            extra: [ '--minify-syntax', ...slimDefines(features) ],
        },
        {
            entry: 'src/js/run-repl/repl.js',
            js: 'src/bundles/js/core/run-repl.js',
            c: 'src/bundles/c/core/run-repl.c',
            module: 'tjs:internal/run-repl',
            prefix: 'tjs__',
            metafile: true,
            extra: [ '--log-override:direct-eval=silent' ],
        },
        // Compiled straight from source -- no esbuild pass, like the Makefile.
        {
            js: 'src/js/worker/worker-bootstrap.js',
            c: 'src/bundles/c/core/worker-bootstrap.c',
            module: 'tjs:internal/worker-bootstrap',
            prefix: 'tjs__',
        },
        {
            js: 'src/js/internal/path.js',
            c: 'src/bundles/c/internal/path.c',
            module: 'tjs:internal/path',
            prefix: 'tjs__internal_',
        },
    ];

    for (const file of fs.readdirSync(abs('src/js/stdlib')).sort()) {
        if (!file.endsWith('.js')) {
            continue;
        }

        const name = file.slice(0, -3);

        specs.push({
            entry: `src/js/stdlib/${file}`,
            js: `src/bundles/js/stdlib/${file}`,
            c: `src/bundles/c/stdlib/${name}.c`,
            module: `tjs:${name}`,
            prefix: 'tjs__',
            extra: [ '--external:buffer', '--external:crypto' ],
        });
    }

    return specs;
}

function generateBundles(tjsc) {
    const specs = bundleSpecs();

    log(`generating ${specs.length} bundles (slim CLI, compressed bytecode)`);

    for (const spec of specs) {
        if (spec.entry) {
            fs.mkdirSync(path.dirname(abs(spec.js)), { recursive: true });
            esbuild([
                spec.entry,
                '--bundle',
                ...(spec.metafile ? [ `--metafile=${spec.js}.json` ] : []),
                `--outfile=${spec.js}`,
                '--external:tjs:*',
                ...spec.extra,
                ...ESBUILD_MINIFY,
                ...ESBUILD_COMMON,
            ]);
        }

        fs.mkdirSync(path.dirname(abs(spec.c)), { recursive: true });
        // -z emits miniz-deflated bytecode; it MUST be paired with
        // -DBUILD_WITH_COMPRESSED_BYTECODE=ON below or the loader inflates
        // garbage. Both are unconditional here so they cannot drift apart.
        run(tjsc, [
            '-m', '-s', '-z',
            '-o', abs(spec.c),
            '-n', spec.module,
            '-p', spec.prefix,
            abs(spec.js),
        ], { cwd: root, verbose: false });
    }
}

// src/bundles/c is tracked in git and shared by every build dir, so a build
// here would otherwise leave a developer's tree holding slim, compressed
// bundles. Snapshot the directory verbatim (not `git checkout`, which would
// also discard uncommitted bundle edits) and put it back afterwards.
function snapshotBundles() {
    const dir = abs('src/bundles/c');

    if (!fs.existsSync(dir)) {
        return null;
    }

    const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-bundles-'));

    fs.cpSync(dir, snap, { recursive: true });

    return snap;
}

let bundleSnapshot = null;

// Idempotent: called from the `finally` below, from fail(), and from the signal
// handlers, whichever gets there first.
function restoreBundles() {
    if (!bundleSnapshot) {
        return;
    }

    const snap = bundleSnapshot;

    bundleSnapshot = null;

    log('restoring src/bundles to its pre-build state');
    rmrf(abs('src/bundles/c'));
    fs.cpSync(snap, abs('src/bundles/c'), { recursive: true });
    rmrf(snap);
    // Generated, git-ignored intermediates; regenerated by `make js`.
    rmrf(abs('src/bundles/js'));
}

// ---------------------------------------------------------------------------
// Phase 3 -- configure & build tjs
// ---------------------------------------------------------------------------

// Detect MSVC up front: it silently compiles nine of the eleven levers out
// (including BUILD_WITH_HARDENING itself), so the Windows artifact gets an
// honest profile name rather than a misleading "hardened" one.
function detectMsvc() {
    if (!isWindows) {
        return false;
    }

    const cc = (process.env.CC ?? '').toLowerCase();

    return !(cc.includes('clang') || cc.includes('gcc'));
}

const msvc = detectMsvc();
const balanced = opts.optimization === 'balanced';
const tuned = opts.optimization === 'tuned';
const artifactProfile = opts.optimization === 'smallest'
    ? opts.profile
    : `${opts.optimization}-${opts.profile}`;
// MSVC compiles the hardening lever out, so its artifacts must not claim to be
// hardened even though they are configured identically otherwise.
const profile = `${opts.optimization}-compressed-${opts.profile}${msvc ? '' : '-hardened'}`;

function buildTjs() {
    const dir = path.resolve(root, opts['build-dir']);
    // Matches __TJS_TLS_CA__ above: on a non-TLS build this also compiles the
    // vm.c CA setter out. MSVC needs the /D spelling.
    const noTlsCa = `-DCMAKE_C_FLAGS=${msvc ? '/D' : '-D'}TJS_NO_TLS_CA`;
    const flags = [
        '-DCMAKE_BUILD_TYPE=MinSizeRel',
        '-DBUILD_WITH_WASM=OFF',
        `-DBUILD_WITH_SQLITE=${features.sqlite ? 'ON' : 'OFF'}`,
        `-DBUILD_WITH_TLS=${features.tls ? 'ON' : 'OFF'}`,
        `-DBUILD_WITH_FFI=${features.ffi ? 'ON' : 'OFF'}`,
        '-DBUILD_WITH_MIMALLOC=OFF',
        `-DBUILD_WITH_REPL=${REPL ? 'ON' : 'OFF'}`,
        '-DBUILD_WITH_LTO=ON',
        '-DBUILD_WITH_GC_SECTIONS=ON',
        '-DBUILD_WITH_COMPRESSED_BYTECODE=ON',
    ];

    if (features.tls) {
        // lws cannot fall back to the OS trust store with the mbedtls backend,
        // so a TLS build without the (compressed) bundled CA would fail every
        // certificate verification unless the user sets TJS_CA_BUNDLE.
        flags.push('-DBUILD_WITH_BUNDLED_CA=ON');
    } else {
        flags.push(noTlsCa);
    }

    if (!msvc) {
        // BUILD_WITH_OZ/NO_OUTLINE/QJS_SPEED/HIDDEN_VISIBILITY/STRIP/
        // NO_UNWIND_TABLES/REPRODUCIBLE_PATHS/ICF/HARDENING are all `NOT
        // MSVC`-guarded. Passing them would be accepted and do nothing.
        flags.push(
            '-DBUILD_WITH_OZ=ON',
            `-DBUILD_WITH_NO_OUTLINE=${tuned ? 'ON' : 'OFF'}`,
            `-DBUILD_WITH_QJS_SPEED=${balanced ? 'ON' : 'OFF'}`,
            '-DBUILD_WITH_HIDDEN_VISIBILITY=ON',
            '-DBUILD_WITH_ICF=ON',
            '-DBUILD_WITH_STRIP=ON',
            '-DBUILD_WITH_NO_UNWIND_TABLES=ON',
            '-DBUILD_WITH_REPRODUCIBLE_PATHS=ON',
            '-DBUILD_WITH_HARDENING=ON',
        );
    }

    log(`building tjs (${profile}) in ${dir}`);
    run('cmake', [ '-B', dir, '-S', root, ...flags, ...opts['cmake-arg'] ], { cwd: root });
    run('cmake', [ '--build', dir, '--config', 'MinSizeRel', '--parallel', String(jobs) ],
        { cwd: root });

    const found = findBuilt(dir, 'tjs', 'MinSizeRel');

    if (!found) {
        fail(`tjs not found after building in ${dir}`);
    }

    return found;
}

// ---------------------------------------------------------------------------
// Phase 4 -- verify
// ---------------------------------------------------------------------------

// language=JavaScript
const SMOKE_COMMON = `
// Smoke test for the slim dist binary. Throws on the first failure; the exit
// code is what the build script checks.

function check(cond, what) {
    if (!cond) {
        throw new Error('smoke: ' + what);
    }
}

// Compressed bytecode actually inflates: these all live in the polyfill bundle.
check(typeof fetch === 'function', 'fetch missing');
check(typeof URL === 'function', 'URL missing');
check(typeof URLPattern === 'function', 'URLPattern missing');
check(new URL('http://a/b?c=1').searchParams.get('c') === '1', 'URL broken');
check(typeof XMLHttpRequest === 'function', 'XMLHttpRequest missing');

// Common to every profile.
check(typeof WebAssembly === 'undefined', 'WebAssembly should be compiled out');
check(tjs.engine.features.wasm === false, 'features.wasm should be false');

// WebCrypto is on in this profile. Assert the capability, not the feature
// flag: tjs.engine.features.webcrypto only exists on builds that carry the
// BUILD_WITH_WEBCRYPTO option, so check it only when it is reported.
check(typeof crypto.subtle === 'object' && crypto.subtle !== null, 'crypto.subtle missing');
check(tjs.engine.features.webcrypto !== false, 'features.webcrypto should not be false');
check(typeof crypto.randomUUID() === 'string', 'randomUUID broken');
`;

// language=JavaScript
const SMOKE_FFI = `
import ffi from 'tjs:ffi';

check(tjs.engine.features.ffi === true, 'features.ffi should be true');

// dlopen the platform libc and actually call into it.
const libs = {
    macOS: [ 'libSystem.B.dylib' ],
    Windows: [ 'msvcrt.dll' ],
}[navigator.userAgentData.platform] ??
    [ 'libc.so.6', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1', 'libc.so' ];
let opened = null;
let lastError = null;

for (const name of libs) {
    try {
        opened = ffi.dlopen(name, { abs: { args: [ 'sint' ], returns: 'sint' } });
        break;
    } catch (e) {
        lastError = e;
    }
}

check(opened !== null, 'ffi.dlopen failed for all of [' + libs.join(', ') + ']: ' + lastError);
check(opened.symbols.abs(-7) === 7, 'ffi call returned the wrong value');
opened.close();
`;

// language=JavaScript
const SMOKE_NO_FFI = `
// The feature flag is the load-bearing assertion here. Importing an
// unregistered tjs: module currently rejects with QuickJS's uninitialized
// sentinel rather than an Error, so the catch below proves less than it looks
// like it does -- see the F9 finding in
// .claude/plans/archive/2026-08-19_upstream-pr-silent-module-load.md.
check(tjs.engine.features.ffi === false, 'features.ffi should be false');

let ffiLoaded = true;

try {
    await import('tjs:ffi');
} catch {
    ffiLoaded = false;
}

check(!ffiLoaded, 'tjs:ffi should be compiled out');
`;

// language=JavaScript
const SMOKE_TLS = `
check(tjs.engine.features.tls === true, 'features.tls should be true');
// A TLS build without a trust store is useless here: lws cannot fall back to
// the OS store on its mbedtls backend.
check(tjs.engine.features.bundledCa === true, 'features.bundledCa should be true');
`;

// language=JavaScript
const SMOKE_NO_TLS = `
check(tjs.engine.features.tls === false, 'features.tls should be false');
// TJS_HAVE_BUNDLED_CA is TLS-gated in CMakeLists.txt, so a true here would mean
// the two options had drifted apart.
check(tjs.engine.features.bundledCa === false, 'features.bundledCa should be false');
`;

// language=JavaScript
const SMOKE_SQLITE = `
import { Database } from 'tjs:sqlite';

check(tjs.engine.features.sqlite === true, 'features.sqlite should be true');

// Exercise the amalgamation, not just the flag: an in-memory round trip is the
// cheapest proof that deps/sqlite3 was actually linked in and works.
const db = new Database(':memory:');

db.exec('CREATE TABLE t (n INT)');

const ins = db.prepare('INSERT INTO t VALUES (?)');

ins.run(41);
ins.finalize();

const sel = db.prepare('SELECT n FROM t');
const rows = sel.all();

sel.finalize();
check(rows.length === 1 && rows[0].n === 41, 'sqlite round trip broken');
db.close();
`;

// language=JavaScript
const SMOKE_NO_SQLITE = `
// Mirror image of SMOKE_SQLITE: the point of this pair is that a silently
// flipped BUILD_WITH_SQLITE default fails the build, in either direction.
check(tjs.engine.features.sqlite === false, 'features.sqlite should be false');
`;

function smokeSource() {
    return [
        SMOKE_COMMON,
        features.ffi ? SMOKE_FFI : SMOKE_NO_FFI,
        features.tls ? SMOKE_TLS : SMOKE_NO_TLS,
        features.sqlite ? SMOKE_SQLITE : SMOKE_NO_SQLITE,
        'console.log(\'smoke: ok\');\n',
    ].join('\n');
}

function verify(bin) {
    // Read the version from CMakeLists.txt, not the generated (git-ignored)
    // src/version.h, so this works on a tree that has never been configured.
    const cmakeLists = fs.readFileSync(abs('CMakeLists.txt'), 'utf8');
    const [ major, minor, patch ] = [ 'MAJOR', 'MINOR', 'PATCH' ].map(k =>
        cmakeLists.match(new RegExp(`set\\(TJS__VERSION_${k}\\s+([^)]+)\\)`))?.[1].trim());
    const suffix = cmakeLists.match(/set\(TJS__VERSION_SUFFIX\s+"([^"]*)"\)/)?.[1] ?? '';
    const expected = `v${major}.${minor}.${patch}${suffix}`;
    const got = capture(bin, [ '-v' ]);

    if (got !== expected) {
        fail(`\`tjs -v\` printed ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }

    log(`version:   ${got}`);

    if (opts['skip-smoke']) {
        return;
    }

    const smokeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-smoke-')), 'smoke.js');

    fs.writeFileSync(smokeFile, smokeSource());

    try {
        // The slim CLI gates out `test`, so this binary cannot run the suite on
        // itself -- full-suite validation is a separate CI job on a normal
        // build. Do not "fix" that by re-enabling the test runner here.
        run(bin, [ 'run', smokeFile ]);
        verifyCompile(bin, smokeFile);
    } finally {
        rmrf(path.dirname(smokeFile));
    }
}

// `compile` is one of the few subcommands every profile keeps, and it is the
// one most easily broken by the CLI gating defines (it also pulls in the
// standalone-binary writer). Prove it end to end: compile the smoke script and
// run the resulting self-contained binary.
function verifyCompile(bin, smokeFile) {
    const out = path.join(path.dirname(smokeFile), isWindows ? 'smoke-bin.exe' : 'smoke-bin');

    run(bin, [ 'compile', smokeFile, out ]);

    if (!fs.existsSync(out)) {
        fail(`\`tjs compile\` produced no binary at ${out}`);
    }

    run(out, []);
    log('compile:   ok (standalone binary runs)');
}

// Prefers the measured platform+profile baseline; falls back to the flat
// per-platform budget on anything not in MEASURED, so an unmeasured platform
// still gets a gate rather than none.
function sizeBudget() {
    const explicit = Number(opts['max-size']);

    if (explicit) {
        return { budget: explicit, measured: null, basis: '--max-size' };
    }

    const measured = MEASURED[platformKey]?.[artifactProfile];

    if (measured) {
        return {
            budget: Math.round(measured * SIZE_HEADROOM),
            measured,
            basis: `measured +${Math.round((SIZE_HEADROOM - 1) * 100)}%`,
        };
    }

    const smallestBaseline = MEASURED[platformKey]?.[opts.profile];

    if (opts.optimization !== 'smallest' && smallestBaseline) {
        return {
            budget: Math.round(smallestBaseline * 1.25),
            measured: null,
            basis: 'temporary smallest baseline +25%',
        };
    }

    return {
        budget: (FALLBACK_BUDGETS[platformKey] ?? 2097152) + FALLBACK_PROFILE_DELTA[opts.profile],
        measured: null,
        basis: `${platformKey} not measured -- fallback budget`,
    };
}

function checkSize(bin) {
    const size = fs.statSync(bin).size;
    const { budget, measured, basis } = sizeBudget();

    log(`size:      ${fmtBytes(size)}  (budget ${fmtBytes(budget)}, ${platformKey}, `
        + `${artifactProfile}, ${basis})`);

    if (measured !== null && size !== measured) {
        const delta = size - measured;

        log(`note:      ${delta > 0 ? '+' : ''}${delta} B vs the recorded ${platformKey} `
            + `${artifactProfile} baseline (${measured} B)`);
    }

    const expect = Number(opts['expect-size']);

    if (expect && size !== expect) {
        fail(`size ${size} != --expect-size ${expect}`);
    }

    if (size > budget) {
        const msg = `binary is ${size - budget} B over the ${platformKey} budget`;

        if (opts['enforce-size']) {
            fail(msg);
        }

        log(`WARNING:   ${msg} (not enforced; pass --enforce-size to make this fatal)`);
    }

    return size;
}

// ---------------------------------------------------------------------------
// Phase 5 -- package
// ---------------------------------------------------------------------------

function packageArtifact(bin, size) {
    const outDir = path.resolve(root, opts.out);

    fs.mkdirSync(outDir, { recursive: true });

    const name = isWindows ? 'tjs.exe' : 'tjs';
    const dest = path.join(outDir, name);

    copyExecutable(bin, dest);

    if (!isWindows) {
        // actions/upload-artifact does not carry Unix permissions; the release
        // workflow re-chmods before zipping, but set it here too so a locally
        // produced artifact is directly runnable.
        fs.chmodSync(dest, 0o755);
    }

    const digest = sha256(dest);

    fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${digest}  ${name}\n`);
    fs.writeFileSync(path.join(outDir, 'BUILDINFO.txt'),
        [
            `profile:  ${profile}`,
            `optimization: ${opts.optimization}`,
            `features: ffi=${features.ffi} tls=${features.tls} `
                + `sqlite=${features.sqlite} wasm=false webcrypto=true`,
            `platform: ${platformKey}`,
            `size:     ${size}`,
            `sha256:   ${digest}`,
            `msvc:     ${msvc}`,
            '',
        ].join('\n'));

    log(`artifact:  ${dest}`);
    log(`sha256:    ${digest}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

bundleSnapshot = opts['keep-bundles'] ? null : snapshotBundles();
cleanup = restoreBundles;

try {
    const { tjsc, dir: hostDir } = buildHostTjsc();

    if (opts['host-tjs']) {
        buildHostTjs(hostDir);
    }

    generateBundles(tjsc);

    if (opts['bundles-only']) {
        log('--bundles-only: stopping after bundle generation');

        if (!opts['keep-bundles']) {
            log('note: pass --keep-bundles to inspect the generated bundles; '
                + 'they are about to be restored');
        }
    } else {
        const bin = buildTjs();

        verify(bin);

        const size = checkSize(bin);

        packageArtifact(bin, size);
    }
} finally {
    restoreBundles();
}

log('done');
