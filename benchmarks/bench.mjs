#!/usr/bin/env node
// Benchmark driver. Phase P1/P2 of .claude/plans/2026-08-20_ci-benchmark-suite.md:
// measures one or more already-built binaries and writes one schemaVersion-1 result JSON.
//
// It deliberately does NOT build anything yet. Building `full` plus four dist profiles is
// P4's job inside bench.yml, and doing it here would mean this script rewrites src/bundles/
// -- which is TRACKED in this fork -- as a side effect of a read-only-looking measurement.
// Point --binary at binaries that already exist; the driver only reads them.
//
//   node benchmarks/bench.mjs --binary full=./build/tjs
//   node benchmarks/bench.mjs --binary full=./build/tjs --binary min=./dist/min/tjs
//   node benchmarks/bench.mjs --binary full=./build/tjs --quick   # smoke: 5 spawns, 1 rep

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { platformId, readFeatures, repoInfo, runnerInfo, toolchainInfo } from './lib/env.mjs';
import { checkedRun, detectTime, parseBenchLines, runWithTime, timeSpawn } from './lib/proc.mjs';
import { measureSize } from './lib/sizes.mjs';
import { round, summarize } from './lib/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORKLOADS = path.join(HERE, 'workloads');

const SCHEMA_VERSION = 1;

// name -> feature key it needs, or null when feature-neutral. A workload whose feature is
// off records null and lands in `skipped`; per METHODOLOGY.md rule 7 it never becomes 0.
const THROUGHPUT = [
    { name: 'compute', feature: null },
    { name: 'json', feature: null },
    { name: 'regex', feature: null },
    { name: 'crypto', feature: 'webcrypto' },
    { name: 'eventloop', feature: null },
    { name: 'fs', feature: null }
];

const { values } = parseArgs({
    options: {
        binary: { type: 'string', multiple: true, default: [] },
        out: { type: 'string' },
        reps: { type: 'string', default: '5' },
        spawns: { type: 'string', default: '50' },
        warmups: { type: 'string', default: '10' },
        quick: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
    }
});

if (values.help || values.binary.length === 0) {
    console.log(`Usage: node benchmarks/bench.mjs --binary <id>=<path> [--binary ...] [options]

  --binary <id>=<path>  A binary to measure. Repeatable. Conventional ids:
                        full, balanced-min, tuned-min, min, ffi, tls, ffi-tls.
  --out <path>          Result JSON destination (default: benchmarks/history/<platform>/<version>.json)
  --spawns <n>          Measured startup spawns per workload (default 50)
  --warmups <n>         Warmup spawns, discarded (default 10)
  --reps <n>            Throughput repetitions; best-of-N is reported (default 5)
  --quick               Smoke mode: 5 spawns, 2 warmups, 1 rep. Not a valid measurement.
`);
    process.exit(values.help ? 0 : 1);
}

const spawns = values.quick ? 5 : Number(values.spawns);
const warmups = values.quick ? 2 : Number(values.warmups);
const reps = values.quick ? 1 : Number(values.reps);

for (const [ label, n ] of [ [ 'spawns', spawns ], [ 'warmups', warmups ], [ 'reps', reps ] ]) {
    if (!Number.isInteger(n) || n < 1) {
        fail(`--${label} must be a positive integer, got ${JSON.stringify(n)}`);
    }
}

// Fail before doing 10 minutes of work, not after: an absent /usr/bin/time means every
// memory row would be null, and a result file that looks complete but silently is not is
// worse than no result file.
const timeTool = detectTime();

const binaries = {};

for (const spec of values.binary) {
    const eq = spec.indexOf('=');

    if (eq === -1) {
        fail(`--binary expects <id>=<path>, got ${JSON.stringify(spec)}`);
    }

    const id = spec.slice(0, eq);
    const exe = path.resolve(spec.slice(eq + 1));

    if (binaries[id]) {
        fail(`duplicate --binary id ${JSON.stringify(id)}`);
    }

    binaries[id] = exe;
}

const repo = repoInfo(REPO);
const result = {
    schemaVersion: SCHEMA_VERSION,
    version: repo.version,
    commit: repo.commit,
    dirty: repo.dirty,
    date: new Date().toISOString(),
    platform: platformId(),
    quick: values.quick,
    config: { spawns, warmups, reps, timeTool: `${timeTool.path} (${timeTool.dialect})` },
    runner: runnerInfo(),
    toolchain: toolchainInfo(),
    binaries: {}
};

if (repo.dirty) {
    // Recorded, not refused: measuring uncommitted work is the normal local case. It just
    // must never be mistaken for a reproducible datapoint in the committed history.
    warn('working tree is dirty; this result is not reproducible from `commit` alone');
}

for (const [ id, exe ] of Object.entries(binaries)) {
    console.error(`\n== ${id} (${exe})`);
    result.binaries[id] = measureBinary(id, exe);
}

const outPath = values.out
    ? path.resolve(values.out)
    : path.join(HERE, 'history', result.platform, `${sanitize(result.version ?? 'unknown')}.json`);

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

console.error(`\nwrote ${path.relative(process.cwd(), outPath)}`);

function measureBinary(id, exe) {
    const { features, cli } = readFeatures(exe);

    const on = Object.entries(features).filter(([ , v ]) => v).map(([ k ]) => k);

    console.error(`   features: ${on.join(' ') || '(none)'}`);

    const size = measureSize(exe);

    console.error(`   size: ${(size.raw / 1024).toFixed(0)} KiB raw, ${(size.gzip / 1024).toFixed(0)} KiB gzip`);

    const noop = measureStartup(exe, 'noop.js', '');
    // 'READY' is not decoration. A failed static import of a `tjs:` module aborts with
    // exit status 0 and no output, so status-0 does not prove the imports resolved -- a
    // broken workload would otherwise be recorded as an impressively fast startup.
    const importStdlib = measureStartup(exe, 'import-stdlib.js', 'READY');

    console.error(`   startup: noop ${fmt(noop.median)}ms  +stdlib ${fmt(importStdlib.median)}ms`);

    const baseline = measureResources(exe, path.join(WORKLOADS, 'noop.js'));

    const ops = {};
    const skipped = [];
    let workloadPeak = null;
    let cpu = null;

    for (const { name, feature } of THROUGHPUT) {
        if (feature && !features[feature]) {
            skipped.push(name);
            console.error(`   ${name}: SKIP (feature '${feature}' is off)`);
            continue;
        }

        const file = path.join(WORKLOADS, `${name}.js`);
        // Best-of-N across whole process runs. Minimum, not mean: for compute-bound work
        // every sample is the true cost plus some amount of interference, so the smallest
        // sample is the least-contaminated estimator (METHODOLOGY.md rule 3).
        const byMetric = new Map();

        for (let rep = 0; rep < reps; rep++) {
            const r = checkedRun(exe, [ 'run', file ], `${id}: workload ${name}`);

            for (const line of parseBenchLines(r.stdout)) {
                const opsPerSec = line.ms > 0 ? (line.ops / line.ms) * 1000 : null;
                const prev = byMetric.get(line.name);

                if (opsPerSec !== null && (prev === undefined || opsPerSec > prev)) {
                    byMetric.set(line.name, opsPerSec);
                }
            }
        }

        if (byMetric.size === 0) {
            fail(`${id}: workload ${name} produced no BENCH lines`);
        }

        for (const [ metric, opsPerSec ] of byMetric) {
            ops[metric] = round(opsPerSec, 2);
        }

        console.error(`   ${name}: ${[ ...byMetric.keys() ].join(' ')}`);

        // Peak RSS and CPU come from the heaviest workload rather than an average: the
        // question a memory row answers is "how much did it need", not "how much on
        // average". eventloop.js is the allocation-heaviest by construction.
        if (name === 'eventloop') {
            const res = measureResources(exe, file);

            workloadPeak = res.maxRssBytes;
            cpu = res.cpu;
        }
    }

    return {
        path: path.relative(REPO, exe),
        features,
        cli,
        size,
        startup: {
            noopMedianMs: round(noop.median),
            noopMadMs: round(noop.mad),
            noopUnstable: noop.unstable,
            importStdlibMedianMs: round(importStdlib.median),
            importStdlibMadMs: round(importStdlib.mad),
            importStdlibUnstable: importStdlib.unstable,
            runs: noop.runs
        },
        memory: {
            baselineRssBytes: baseline.maxRssBytes,
            workloadPeakRssBytes: workloadPeak
        },
        cpu,
        ops,
        skipped
    };
}

function measureStartup(exe, workload, expectStdout) {
    const args = [ 'run', path.join(WORKLOADS, workload) ];

    const check = r => {
        if (r.error) {
            fail(`${workload} on ${exe}: ${r.error.message}`);
        }

        if (r.status !== 0) {
            fail(`${workload} failed on ${exe} (exit ${r.status}): ${r.stderr.trim()}`);
        }

        if (r.stdout.trim() !== expectStdout) {
            fail(`${workload} on ${exe} printed ${JSON.stringify(r.stdout.trim())}, expected ` +
                `${JSON.stringify(expectStdout)}. A silent import failure exits 0 -- not timing this.`);
        }
    };

    for (let i = 0; i < warmups; i++) {
        check(timeSpawn(exe, args));
    }

    const samples = [];

    for (let i = 0; i < spawns; i++) {
        const r = timeSpawn(exe, args);

        check(r);
        samples.push(r.ms);
    }

    return summarize(samples);
}

function measureResources(exe, file) {
    const r = runWithTime(exe, [ 'run', file ]);

    if (r.status !== 0) {
        fail(`resource run of ${path.basename(file)} failed: ${r.stderr.trim()}`);
    }

    const { maxRssBytes, userS, sysS, wallS } = r.resources;

    if (maxRssBytes === null) {
        fail(`could not parse peak RSS from ${timeTool.path}; refusing to report 0`);
    }

    return {
        maxRssBytes,
        cpu: {
            userS: round(userS),
            sysS: round(sysS),
            wallS: round(wallS),
            // >1 means threaded work happened (mimalloc background threads, GC). Flags a
            // regression that a flat wall clock would hide entirely.
            efficiency: wallS > 0 ? round((userS + sysS) / wallS) : null
        }
    };
}

function fmt(x) {
    return x === null ? '—' : x.toFixed(2);
}

function sanitize(s) {
    return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

function warn(msg) {
    console.error(`bench: warning: ${msg}`);
}

function fail(msg) {
    console.error(`bench: ${msg}`);
    process.exit(1);
}
