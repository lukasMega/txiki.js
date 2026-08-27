#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE = path.join(ROOT, 'scripts', 'feature-study-v1.json');
const OUT_DIR = path.join(ROOT, 'website', 'data', 'slim-metrics', 'feature-costs');

// Canonical platform ids, shared with release-size-manifest.mjs and the website
// generator. Windows is absent on purpose: the study drives `make`, which is the
// one part of the fork's build tooling that build-dist.mjs exists to avoid.
const PLATFORM_IDS = {
    'linux-x64': 'linux-x86_64',
    'linux-arm64': 'linux-arm64',
    'darwin-arm64': 'macos-arm64',
    'darwin-x64': 'macos-x86_64',
};

export const FEATURE_IDS = [
    'wasm',
    'sqlite',
    'tls',
    'bundled-ca',
    'webcrypto',
    'ffi',
    'mimalloc',
    'repl',
    'wasm-full',
    'xhr',
    'eval',
    'serve',
    'bundler',
    'test-runner',
    'compile',
    'app',
    'help',
    'tls-ca',
];

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Executable file size alone cannot resolve a small feature. Mach-O pads every
// segment to a 16 KB page on arm64, so dropping the 6,592 bytes of XHR bytecode
// out of __TEXT,__const moved the file by 224 bytes -- and eight of the pairs in
// this study are CLI defines of exactly that magnitude. `linkedBytes` is the sum
// of the non-zerofill sections, which is not page-quantized, and is the number
// that answers "what does this feature cost". `binaryBytes` stays because it is
// what someone actually downloads.
export function parseLinkedBytes(text, platform) {
    if (platform === 'darwin') {
        // size -m: "\tSection __const: 1062216", with "(zerofill)" on the ones
        // that occupy no file bytes.
        const sections = [ ...text.matchAll(/^\tSection \S+: (\d+)(.*)$/gm) ];

        if (sections.length === 0) {
            return null;
        }

        return sections
            .filter(([ , , tail ]) => !tail.includes('zerofill'))
            .reduce((total, [ , bytes ]) => total + Number(bytes), 0);
    }

    // size --format=sysv: "\.text\s+3974296\s+4198400". .bss and .tbss occupy no
    // file bytes, and the trailing "Total" line would double-count.
    const rows = [ ...text.matchAll(/^(\.\S+)\s+(\d+)\s+\d+$/gm) ];

    if (rows.length === 0) {
        return null;
    }

    return rows
        .filter(([ , name ]) => ![ '.bss', '.tbss' ].includes(name))
        .reduce((total, [ , , bytes ]) => total + Number(bytes), 0);
}

function linkedBytes(file) {
    const darwin = process.platform === 'darwin';
    const out = capture('size', darwin ? [ '-m', file ] : [ '--format=sysv', file ]);

    return out === null ? null : parseLinkedBytes(out, process.platform);
}

function binary(file) {
    const resolved = path.resolve(file);

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`binary does not exist: ${file}`);
    }

    const measured = {
        binaryBytes: fs.statSync(resolved).size,
        sha256: sha256(resolved),
    };
    const linked = linkedBytes(resolved);

    return linked === null ? measured : { ...measured, linkedBytes: linked };
}

function differingKeys(baseline, variant) {
    const keys = new Set([ ...Object.keys(baseline ?? {}), ...Object.keys(variant ?? {}) ]);

    return [ ...keys ].filter(key => baseline?.[key] !== variant?.[key]).sort();
}

export function measure(config, configDir = process.cwd()) {
    if (config.schemaVersion !== 1) {
        throw new Error(`unsupported feature-study config schema ${config.schemaVersion}`);
    }

    for (const key of [ 'id', 'commit', 'date', 'platform', 'recipe' ]) {
        if (!config[key]) {
            throw new Error(`feature-study config lacks ${key}`);
        }
    }

    if (!/^[0-9a-f]{40}$/.test(config.commit)) {
        throw new Error('feature-study commit must be full SHA-1');
    }

    if (Number.isNaN(Date.parse(config.date))) {
        throw new Error('feature-study date must be ISO-8601');
    }

    if (!Array.isArray(config.pairs) || config.pairs.length === 0) {
        throw new Error('feature-study config needs paired variants');
    }

    const baselinePath = path.resolve(configDir, config.baseline.path);
    const baselineBinary = binary(baselinePath);
    const seen = new Set();
    const pairs = config.pairs.map(pair => {
        if (!FEATURE_IDS.includes(pair.id)) {
            throw new Error(`unknown removable feature ${pair.id}`);
        }

        if (seen.has(pair.id)) {
            throw new Error(`duplicate removable feature ${pair.id}`);
        }

        seen.add(pair.id);
        const changes = differingKeys(config.baseline.features, pair.features);
        const expectedChanges = [ pair.id, ...(pair.companionChanges ?? []) ].sort();

        if (JSON.stringify(changes) !== JSON.stringify(expectedChanges)) {
            throw new Error(`${pair.id} feature vector changed ${changes.join(', ') || 'nothing'}`);
        }

        const variant = binary(path.resolve(configDir, pair.path));
        const linked = baselineBinary.linkedBytes !== undefined && variant.linkedBytes !== undefined
            ? {
                onLinkedBytes: baselineBinary.linkedBytes,
                offLinkedBytes: variant.linkedBytes,
                deltaLinkedBytes: baselineBinary.linkedBytes - variant.linkedBytes,
            }
            : {};

        return {
            id: pair.id,
            label: pair.label,
            category: pair.category,
            setting: pair.setting,
            onBytes: baselineBinary.binaryBytes,
            offBytes: variant.binaryBytes,
            deltaBytes: baselineBinary.binaryBytes - variant.binaryBytes,
            ...linked,
            onSha256: baselineBinary.sha256,
            offSha256: variant.sha256,
            changedFeatures: changes,
            notes: pair.notes ?? [],
        };
    }).sort((a, b) => FEATURE_IDS.indexOf(a.id) - FEATURE_IDS.indexOf(b.id));

    return {
        schemaVersion: 1,
        id: config.id,
        commit: config.commit,
        date: new Date(config.date).toISOString(),
        platform: config.platform,
        recipe: config.recipe,
        toolchain: config.toolchain ?? {},
        baseline: {
            ...baselineBinary,
            features: config.baseline.features,
        },
        pairs,
    };
}

function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Build driver (--build)
//
// Produces the 1 + N binaries `measure()` above records. Everything it needs to
// vary lives in scripts/feature-study-v1.json so the recipe table and the
// recorder cannot drift; this half only knows how to turn a switch set into a
// binary and how to prove the switch actually landed.
// ---------------------------------------------------------------------------

function fail(message) {
    process.stderr.write(`feature-study: ${message}\n`);
    process.exit(1);
}

function log(message) {
    process.stdout.write(`feature-study: ${message}\n`);
}

function run(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

    if (result.error) {
        fail(`${cmd} failed to start: ${result.error.message}`);
    }

    if (result.status !== 0) {
        fail(`${cmd} ${args.join(' ')} exited ${result.status ?? result.signal}`);
    }
}

function capture(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });

    if (result.error || result.status !== 0) {
        return null;
    }

    return result.stdout;
}

function firstLine(text) {
    return (text ?? '').split('\n')[0].trim();
}

export function loadRecipe(file) {
    const recipe = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (recipe.schemaVersion !== 1) {
        throw new Error(`unsupported recipe schema ${recipe.schemaVersion}`);
    }

    const seen = new Set();

    for (const pair of recipe.pairs) {
        if (!FEATURE_IDS.includes(pair.id)) {
            throw new Error(`recipe names unknown feature ${pair.id}`);
        }

        if (seen.has(pair.id)) {
            throw new Error(`recipe repeats feature ${pair.id}`);
        }

        seen.add(pair.id);

        if (!pair.cmake && !pair.defines) {
            throw new Error(`${pair.id} changes no switch`);
        }

        // `probe: null` is how a pair declares it has no runtime signal. Leaving
        // the key out instead would make an unprobeable pair indistinguishable
        // from one whose probe was forgotten.
        if (pair.probe === undefined) {
            throw new Error(`${pair.id} declares no probe; use "probe": null with a probeNote if it has none`);
        }
    }

    const missing = FEATURE_IDS.filter(id => !seen.has(id));

    if (missing.length > 0) {
        throw new Error(`recipe omits ${missing.join(', ')}`);
    }

    return recipe;
}

// The runtime evidence that a switch landed. features/cli come straight from the
// binary; mimalloc and XHR have no entry in either vector, so they are probed
// through the only other thing that changes.
const PROBE_SOURCE = `const out = {
    features: { ...tjs.engine.features },
    cli: tjs.engine.cli ? { ...tjs.engine.cli } : null,
    mimalloc: typeof tjs.engine.versions.mimalloc === 'number',
    xhr: typeof globalThis.XMLHttpRequest === 'function'
};
console.log(JSON.stringify(out));
`;

export function flatProbe(probe) {
    const flat = {};

    for (const [ key, value ] of Object.entries(probe?.features ?? {})) {
        flat[`features.${key}`] = value;
    }

    for (const [ key, value ] of Object.entries(probe?.cli ?? {})) {
        flat[`cli.${key}`] = value;
    }

    for (const key of [ 'mimalloc', 'xhr' ]) {
        if (probe && key in probe) {
            flat[key] = probe[key];
        }
    }

    return flat;
}

function probe(binary, probeFile) {
    const out = capture(binary, [ 'run', probeFile ], { stdio: [ 'ignore', 'pipe', 'inherit' ] });

    if (out === null) {
        fail(`probe did not run under ${binary}`);
    }

    try {
        return flatProbe(JSON.parse(out.trim().split('\n').pop()));
    } catch {
        fail(`probe under ${binary} printed something that is not JSON: ${out.trim()}`);
    }
}

// A pair that changed the declared runtime keys and nothing else. Both halves
// matter: a build that came out smaller while keeping its feature is a broken
// measurement, and one that dropped a second feature silently inflates the bar.
function assertProbe(id, baseline, variant, expected) {
    const changed = Object.keys(baseline)
        .filter(key => baseline[key] !== variant[key])
        .sort();
    const wanted = Object.keys(expected).sort();

    if (JSON.stringify(changed) !== JSON.stringify(wanted)) {
        fail(`${id} changed runtime keys [${changed.join(', ')}], recipe declares [${wanted.join(', ')}]`);
    }

    for (const key of wanted) {
        if (variant[key] !== expected[key]) {
            fail(`${id} probe ${key} is ${variant[key]}, recipe expects ${expected[key]}`);
        }
    }

    const appeared = Object.keys(variant).filter(key => !(key in baseline));

    if (appeared.length > 0) {
        fail(`${id} grew runtime keys the baseline never had: ${appeared.join(', ')}`);
    }
}

// src/bundles/c is tracked in this fork and shared by every build dir, so a
// define-changing variant would otherwise leave the tree holding that variant's
// bytecode. Snapshot verbatim rather than `git checkout` -- the tree may legally
// hold regenerated-but-identical bundles when the run starts.
function snapshotBundles() {
    const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-feature-study-bundles-'));

    fs.cpSync(path.join(ROOT, 'src', 'bundles', 'c'), snap, { recursive: true });

    return snap;
}

function restoreBundles(snap) {
    if (!snap) {
        return;
    }

    const dir = path.join(ROOT, 'src', 'bundles', 'c');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(snap, dir, { recursive: true });
}

function trackedTreeIsClean(...paths) {
    const args = [ 'status', '--porcelain', '--untracked-files=no', ...paths.length > 0 ? [ '--', ...paths ] : [] ];

    return (capture('git', args) ?? 'unknown') === '';
}

function esbuildBinary() {
    const bin = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

    if (!fs.existsSync(bin)) {
        fail('node_modules/esbuild not found -- run `npm install` first (npx would hit the network)');
    }

    return bin;
}

const RUN_MAIN_KEYS = [
    '__TJS_REPL__',
    '__TJS_EVAL__',
    '__TJS_SERVE__',
    '__TJS_BUNDLER__',
    '__TJS_TEST_RUNNER__',
    '__TJS_COMPILE__',
    '__TJS_APP__',
    '__TJS_HELP__',
    '__TJS_TLS_CA__',
];

function defineArgs(defines, keys) {
    return keys.map(key => `--define:${key}=${defines[key]}`).join(' ');
}

// Regenerates src/bundles/c for one define set. `make -B core stdlib` is the
// same path `make js` takes; BUILD_DIR points at the study's own tree so the
// developer's ./build never gets a feature-reduced CMake cache.
function buildBundles(defines, hostDir, jobs, esbuild) {
    run('make', [
        '-B', 'core', 'stdlib',
        `BUILD_DIR=${hostDir}`,
        `JOBS=${jobs}`,
        `ESBUILD=${esbuild}`,
        `RUN_MAIN_DEFINES=${defineArgs(defines, RUN_MAIN_KEYS)}`,
        `POLYFILLS_DEFINES=${defineArgs(defines, [ '__TJS_XHR__' ])}`,
    ]);
}

function buildVariant(buildDir, cmake, buildType, jobs) {
    const flags = Object.entries(cmake).map(([ key, value ]) => `-D${key}=${value}`);

    run('cmake', [ '-B', buildDir, '-S', ROOT, `-DCMAKE_BUILD_TYPE=${buildType}`, ...flags ]);
    run('cmake', [ '--build', buildDir, '--target', 'tjs-cli', '--parallel', String(jobs) ]);

    const binary = path.join(buildDir, 'tjs');

    if (!fs.existsSync(binary)) {
        fail(`no tjs produced in ${buildDir}`);
    }

    return binary;
}

function variantPlan(recipe) {
    const baseline = {
        id: 'baseline',
        cmake: recipe.baseline.cmake,
        defines: recipe.baseline.defines,
        probe: recipe.baseline.probe,
    };
    // Define-less pairs reuse the baseline bundles, so grouping them first turns
    // 19 bundle regenerations into 11. Build order never reaches the record:
    // measure() re-sorts pairs by FEATURE_IDS.
    const pairs = [ ...recipe.pairs ].sort((a, b) => Number(Boolean(a.defines)) - Number(Boolean(b.defines)));

    return [ baseline, ...pairs.map(pair => {
        return {
            ...pair,
            cmake: { ...recipe.baseline.cmake, ...pair.cmake ?? {} },
            defines: { ...recipe.baseline.defines, ...pair.defines ?? {} },
        };
    }) ];
}

export function buildStudy(opts) {
    const recipe = loadRecipe(opts.recipe);
    const platform = opts.platform ?? PLATFORM_IDS[`${process.platform}-${process.arch}`];

    if (!platform) {
        fail(`no canonical platform id for ${process.platform}-${process.arch}; pass --platform`);
    }

    if (process.platform === 'win32') {
        fail('the study drives GNU make and does not run on Windows');
    }

    for (const tool of [ 'git', 'cmake', 'make' ]) {
        if (capture(tool, [ '--version' ]) === null) {
            fail(`${tool} not found on PATH`);
        }
    }

    if (!opts.allowDirty && !trackedTreeIsClean()) {
        fail('tracked tree is dirty; the study must measure a committed state (--allow-dirty to override)');
    }

    const commit = firstLine(capture('git', [ 'rev-parse', 'HEAD' ]));

    if (!/^[0-9a-f]{40}$/.test(commit)) {
        fail('could not read HEAD');
    }

    // The commit's own date, not wall-clock: rerunning the study at the same
    // commit and toolchain must produce a byte-identical record.
    const date = opts.date ?? firstLine(capture('git', [ 'show', '-s', '--format=%cI', 'HEAD' ]));
    const esbuild = esbuildBinary();
    const work = path.resolve(opts.workDir);
    const binDir = path.join(work, 'bin');
    const hostDir = path.join(work, 'host');

    fs.mkdirSync(binDir, { recursive: true });

    // Outside the repo on purpose: `npm run lint` has its own ignore list and
    // would otherwise flag the probe's `tjs` global in the scratch directory.
    const probeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-feature-probe-')), 'probe.js');

    fs.writeFileSync(probeFile, PROBE_SOURCE);

    const plan = variantPlan(recipe)
        .filter(variant => !opts.only || variant.id === 'baseline' || opts.only.includes(variant.id));
    const snapshot = snapshotBundles();
    const restore = () => restoreBundles(snapshot);

    process.on('exit', restore);
    process.on('SIGINT', () => process.exit(130));

    let currentDefines = null;
    let baselineProbe = null;

    try {
        for (const [ index, variant ] of plan.entries()) {
            const target = path.join(binDir, variant.id);
            const defines = JSON.stringify(variant.defines);
            const label = `[${index + 1}/${plan.length}] ${variant.id}`;

            if (opts.resume && fs.existsSync(target)) {
                log(`${label}: reusing existing binary`);
            } else {
                log(`${label}: building`);

                if (defines !== currentDefines) {
                    buildBundles(variant.defines, hostDir, opts.jobs, esbuild);
                    currentDefines = defines;
                }

                const buildDir = path.join(work, `build-${variant.id}`);

                fs.copyFileSync(buildVariant(buildDir, variant.cmake, recipe.buildType, opts.jobs), target);
                fs.chmodSync(target, 0o755);

                if (!opts.keepBuildDirs) {
                    fs.rmSync(buildDir, { recursive: true, force: true });
                }
            }

            const observed = probe(target, probeFile);

            if (variant.id === 'baseline') {
                assertProbe('baseline', flatProbe(variant.probe), observed, {});
                baselineProbe = observed;
            } else {
                assertProbe(variant.id, baselineProbe, observed, flatProbe(variant.probe));
            }
        }
    } finally {
        restore();
        process.off('exit', restore);
    }

    // Scoped to the bundles rather than the whole tree: under --allow-dirty the
    // tree was already dirty on entry, and this assertion is about the one thing
    // the study itself rewrites.
    if (!trackedTreeIsClean('src/bundles/c')) {
        fail('the study left src/bundles/c modified; the snapshot was not restored');
    }

    const measured = plan.filter(variant => variant.id !== 'baseline');
    const features = Object.fromEntries(measured.map(variant => [ variant.id, true ]));

    return measure({
        schemaVersion: 1,
        id: `${commit.slice(0, 8)}-${platform}-${recipe.recipe}`,
        commit,
        date,
        platform,
        recipe: recipe.description,
        toolchain: {
            cc: firstLine(capture('cc', [ '--version' ])),
            cmake: firstLine(capture('cmake', [ '--version' ])),
            node: process.version,
        },
        baseline: { path: 'baseline', features },
        pairs: measured.map(variant => {
            const off = [ variant.id, ...variant.companionChanges ?? [] ].map(id => [ id, false ]);

            return {
                id: variant.id,
                path: variant.id,
                label: variant.label,
                category: variant.category,
                setting: variant.setting,
                features: { ...features, ...Object.fromEntries(off) },
                companionChanges: variant.companionChanges,
                notes: variant.notes ?? [],
            };
        }),
    }, binDir);
}

function defaultJobs() {
    return String(Math.max(1, os.availableParallelism?.() ?? os.cpus().length));
}

function main() {
    const { values } = parseArgs({
        options: {
            build: { type: 'boolean', default: false },
            recipe: { type: 'string', default: RECIPE },
            'work-dir': { type: 'string', default: '.feature-study' },
            jobs: { type: 'string', default: defaultJobs() },
            only: { type: 'string' },
            platform: { type: 'string' },
            date: { type: 'string' },
            resume: { type: 'boolean', default: false },
            'keep-build-dirs': { type: 'boolean', default: false },
            'allow-dirty': { type: 'boolean', default: false },
            config: { type: 'string' },
            out: { type: 'string' },
            check: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h' },
        },
    });

    if (values.help || (!values.build && (!values.config || !values.out))) {
        process.stdout.write(`Usage:
  node scripts/measure-feature-costs.mjs --build [options]
  node scripts/measure-feature-costs.mjs --config <study.json> --out <result.json> [--check]

--build drives the whole paired study: it builds one maximal baseline plus one binary per
removable feature, probes each for the switch it was supposed to change, and writes the record.
Expect an hour or more -- it is a study, not a CI step. It never leaves src/bundles/c modified.

  --recipe <file>      Switch table (default: scripts/feature-study-v1.json)
  --out <file>         Record path (default: website/data/slim-metrics/feature-costs/<commit>-<platform>.json)
  --work-dir <dir>     Build scratch, one tree at a time (default: .feature-study)
  --jobs <n>           Parallel compile jobs (default: cores)
  --only <ids>         Comma-separated feature ids; writes a deliberately partial record
  --resume             Reuse binaries already in <work-dir>/bin
  --keep-build-dirs    Do not delete each CMake tree after copying its binary
  --allow-dirty        Measure an uncommitted tree (the record's commit will not describe it)
  --check              Compare against the existing record instead of writing it

The second form only records binaries someone else built; it is what the tests exercise.
`);

        return;
    }

    let result;
    let out;

    if (values.build) {
        result = buildStudy({
            recipe: path.resolve(values.recipe),
            workDir: values['work-dir'],
            jobs: values.jobs,
            only: values.only?.split(',').map(id => id.trim()).filter(Boolean),
            platform: values.platform,
            date: values.date,
            resume: values.resume,
            keepBuildDirs: values['keep-build-dirs'],
            allowDirty: values['allow-dirty'],
        });
        out = path.resolve(values.out ?? path.join(OUT_DIR, `${result.id.split('-')[0]}-${result.platform}.json`));
    } else {
        const configFile = path.resolve(values.config);

        result = measure(JSON.parse(fs.readFileSync(configFile, 'utf8')), path.dirname(configFile));
        out = path.resolve(values.out);
    }

    const content = stableJson(result);
    const shown = path.relative(ROOT, out);

    if (values.check) {
        if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== content) {
            process.stderr.write(`${shown} is stale\n`);
            process.exitCode = 1;
        }
    } else {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, content);
        process.stdout.write(`wrote ${shown}\n`);
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    main();
}
