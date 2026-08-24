#!/usr/bin/env node
// Golden-file test for report.mjs (plan P3: "so the generator's output is diffable and stable").
//
//   node benchmarks/test/report.test.mjs             # verify
//   node benchmarks/test/report.test.mjs --update    # rewrite the goldens after an intended change
//
// Deliberately not under tests/ at the repo root: that tree is the *runtime's* suite, driven by
// `tjs test` against a tjs binary. This exercises a Node-side generator, so it runs under plain
// node with no dependencies -- same rule as bench.mjs and report.mjs.
//
// The fixture history is frozen input, which is the whole point: real benchmark numbers move
// every run, so a golden test against benchmarks/history/ could never be stable.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { generateReport } from '../report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..');
const REPORT = path.join(BENCH, 'report.mjs');
const METHODOLOGY = path.join(BENCH, 'METHODOLOGY.md');
const FIXTURE_HISTORY = path.join(HERE, 'fixtures', 'history');
const GOLDEN = path.join(HERE, 'fixtures', 'expected-README.md');
const GOLDEN_EMPTY = path.join(HERE, 'fixtures', 'expected-README-empty.md');

const update = process.argv.includes('--update');
const failures = [];

const populated = generateReport({ historyDir: FIXTURE_HISTORY, methodologyPath: METHODOLOGY });
const empty = generateReport({
    historyDir: mkdtempSync(path.join(os.tmpdir(), 'bench-empty-')),
    methodologyPath: METHODOLOGY
});

golden('fixture history', GOLDEN, populated);
golden('empty history', GOLDEN_EMPTY, empty);

check('deterministic across runs', () => {
    const again = generateReport({ historyDir: FIXTURE_HISTORY, methodologyPath: METHODOLOGY });

    assert.equal(again, populated, 'two generations from identical input differ');
});

check('a missing history directory is not a crash', () => {
    const md = generateReport({
        historyDir: path.join(HERE, 'fixtures', 'does-not-exist'),
        methodologyPath: METHODOLOGY
    });

    assert.match(md, /No benchmark runs recorded yet/);
});

// METHODOLOGY.md rule 7, the rule most likely to be broken by a well-meaning refactor: `lite`
// has webcrypto compiled out, so bench.mjs recorded skipped: ["crypto"] and no sha256 keys at
// all. Every crypto cell in its column must be the missing marker, and in particular not 0.
check('a skipped workload never renders as 0', () => {
    const cells = column(populated, 'SHA-256 (MiB/s)');

    assert.ok(cells.length > 0, 'no SHA-256 row found in the generated report');

    for (const row of cells) {
        assert.ok(!/(^|[^0-9.])0([^0-9.]|$)/.test(row.join('')), `a zero leaked into: ${row.join(' | ')}`);
    }

    assert.match(populated, /Workloads skipped because the feature is compiled out/);
});

// An unknown schemaVersion must degrade, not throw: the macos fixture is version 99 and has no
// `memory`, `cpu` or `config` at all.
check('an unknown schemaVersion degrades to the missing marker', () => {
    assert.match(populated, /1 result file uses a schema version this generator does not know/);
    assert.match(populated, /`history\/macos-arm64\/slim-v26\.6\.0-2\.json`/);
    assert.match(populated, /\| CPU efficiency \(\(user\+sys\)\/wall\) \| — \| — \|/);
});

// A metric the catalogue has never heard of still gets a row, because dropping it silently
// would hide exactly the workload someone just added.
check('an unrecognised ops metric still gets a row', () => {
    assert.match(populated, /\| wasm-fib \(—\) \|/);
});

check('--check exits 0 when the file matches and 1 when it does not', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'bench-check-'));
    const out = path.join(tmp, 'README.md');

    writeFileSync(out, populated);

    const ok = runReport([ '--check', '--history', FIXTURE_HISTORY, '--out', out ]);

    assert.equal(ok.status, 0, `--check should pass on an up-to-date file:\n${ok.stderr}`);

    writeFileSync(out, `${populated}stale\n`);

    const stale = runReport([ '--check', '--history', FIXTURE_HISTORY, '--out', out ]);

    assert.equal(stale.status, 1, '--check should fail on a stale file');
    assert.match(stale.stderr, /is stale/);
    assert.match(stale.stderr, /first difference at line \d+|files differ only in trailing content/);
    assert.match(stale.stderr, /Regenerate with:/);
});

if (failures.length > 0) {
    console.error(`\n${failures.length} failing check(s)`);
    process.exit(1);
}

console.log('report.test.mjs: all checks passed');

function golden(name, file, actual) {
    if (update) {
        writeFileSync(file, actual);
        console.log(`updated ${path.relative(BENCH, file)}`);

        return;
    }

    check(`golden: ${name}`, () => {
        let expected;

        try {
            expected = readFileSync(file, 'utf8');
        } catch {
            throw new Error(`${path.relative(BENCH, file)} is missing; run this test with --update`);
        }

        if (expected !== actual) {
            throw new Error(`${path.relative(BENCH, file)} differs from the generated output.\n` +
                `${firstDiff(expected, actual)}\n` +
                'If the change is intended: node benchmarks/test/report.test.mjs --update');
        }
    });
}

function check(name, fn) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (e) {
        failures.push(name);
        console.error(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
    }
}

function firstDiff(expected, actual) {
    const a = expected.split('\n');
    const b = actual.split('\n');

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            return `  line ${i + 1}:\n    golden:    ${JSON.stringify(a[i] ?? null)}\n` +
                `    generated: ${JSON.stringify(b[i] ?? null)}`;
        }
    }

    return '  (differ only in trailing content)';
}

// Every markdown table row whose first cell is `label`, split into cells.
function column(md, label) {
    const rows = [];

    for (const line of md.split('\n')) {
        if (!line.startsWith('| ')) {
            continue;
        }

        const cells = line.slice(1, -1).split('|').map(s => s.trim());

        if (cells[0] === label) {
            rows.push(cells);
        }
    }

    return rows;
}

function runReport(args) {
    const r = spawnSync(process.execPath, [ REPORT, ...args ], { encoding: 'utf8' });

    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
