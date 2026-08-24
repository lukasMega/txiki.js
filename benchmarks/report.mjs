#!/usr/bin/env node
// Report generator. Phase P3 of .claude/plans/2026-08-20_ci-benchmark-suite.md: reads every
// result JSON under benchmarks/history/ (plus, optionally, a run that is not stored there
// yet) and regenerates benchmarks/README.md.
//
//   node benchmarks/report.mjs                        # rewrite benchmarks/README.md
//   node benchmarks/report.mjs --latest /tmp/b.json   # fold in a run not committed to history/
//   node benchmarks/report.mjs --check                # exit 1 if README.md on disk is stale
//
// The output is a pure function of the input JSON plus METHODOLOGY.md -- no wall-clock "now",
// no locale-dependent formatting, no iteration over unordered key sets -- so `--check` can be
// a CI assertion and the golden test in benchmarks/test/ can compare bytes.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { MISSING, cell, fmtBytes, fmtMiB, fmtMs, fmtNum, fmtOps, fmtRatio, table } from './lib/markdown.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The schema this generator was written against. Anything else is rendered best-effort:
// every field access goes through get(), so an unknown or missing field lands as `—`
// instead of throwing, and the reader is told which files were not fully understood.
const KNOWN_SCHEMA = 1;

// Canonical column order, matching METHODOLOGY.md's "What is measured" table. Ids outside
// this list are appended in sorted order rather than dropped, so a new profile shows up in
// the report before anyone edits this file.
const BINARY_ORDER = [
    'full',
    'balanced-min',
    'tuned-min',
    'min',
    'ffi',
    'tls',
    'ffi-tls',
    'ffi-tls-sqlite',
    'sqlite',
    'official-release'
];

// ops/sec metric catalogue. `workload` is the file in workloads/ that emits the metric; it is
// what lets a skipped workload render as `—` rather than as an absent-and-therefore-ambiguous
// cell, since bench.mjs records skips per *workload* but ops per *metric*.
const OPS_METRICS = [
    { key: 'mandelbrot', label: 'mandelbrot', unit: 'px/s', workload: 'compute' },
    { key: 'sort', label: 'array sort', unit: 'elem/s', workload: 'compute' },
    { key: 'string-build', label: 'string build', unit: 'items/s', workload: 'compute' },
    { key: 'json-parse', label: 'JSON.parse', unit: 'docs/s', workload: 'json' },
    { key: 'json-parse-mbps', label: 'JSON.parse', unit: 'MiB/s', workload: 'json' },
    { key: 'json-stringify', label: 'JSON.stringify', unit: 'docs/s', workload: 'json' },
    { key: 'regex-match', label: 'regex match', unit: 'lines/s', workload: 'regex' },
    { key: 'regex-replace', label: 'regex replace', unit: 'corpus/s', workload: 'regex' },
    { key: 'regex-split', label: 'regex split', unit: 'corpus/s', workload: 'regex' },
    { key: 'sha256', label: 'SHA-256', unit: 'digests/s', workload: 'crypto' },
    { key: 'sha256-mbps', label: 'SHA-256', unit: 'MiB/s', workload: 'crypto' },
    { key: 'getrandomvalues', label: 'getRandomValues', unit: 'calls/s', workload: 'crypto' },
    { key: 'timers', label: 'timers', unit: 'timers/s', workload: 'eventloop' },
    { key: 'microtasks', label: 'microtasks', unit: 'tasks/s', workload: 'eventloop' },
    { key: 'fs-write', label: 'fs write', unit: 'files/s', workload: 'fs' },
    { key: 'fs-read', label: 'fs read', unit: 'files/s', workload: 'fs' },
    { key: 'fs-stat', label: 'fs stat', unit: 'stats/s', workload: 'fs' },
    { key: 'fs-readdir', label: 'fs readdir', unit: 'scans/s', workload: 'fs' }
];

const SIZE_ROWS = [
    { label: 'binary size, raw (bytes)', field: 'size.raw', fmt: fmtBytes, dir: 'lower' },
    { label: 'binary size, gzip -9 (bytes)', field: 'size.gzip', fmt: fmtBytes, dir: 'lower' },
    { label: 'text segment (bytes)', field: 'size.text', fmt: fmtBytes, dir: 'lower' },
    { label: 'data segment (bytes)', field: 'size.data', fmt: fmtBytes, dir: 'lower' }
];

const RUNTIME_ROWS = [
    {
        label: 'startup, noop (ms)',
        field: 'startup.noopMedianMs',
        fmt: fmtMs,
        dir: 'lower',
        unstable: 'startup.noopUnstable'
    },
    { label: 'startup, noop MAD (ms)', field: 'startup.noopMadMs', fmt: fmtMs, dir: null },
    {
        label: 'startup, +stdlib (ms)',
        field: 'startup.importStdlibMedianMs',
        fmt: fmtMs,
        dir: 'lower',
        unstable: 'startup.importStdlibUnstable'
    },
    { label: 'startup, +stdlib MAD (ms)', field: 'startup.importStdlibMadMs', fmt: fmtMs, dir: null },
    { label: 'baseline RSS (MiB)', field: 'memory.baselineRssBytes', fmt: fmtMiB, dir: 'lower' },
    { label: 'peak RSS, eventloop (MiB)', field: 'memory.workloadPeakRssBytes', fmt: fmtMiB, dir: 'lower' },
    { label: 'CPU user (s)', field: 'cpu.userS', fmt: fmtNum, dir: 'lower' },
    { label: 'CPU sys (s)', field: 'cpu.sysS', fmt: fmtNum, dir: 'lower' },
    { label: 'CPU efficiency ((user+sys)/wall)', field: 'cpu.efficiency', fmt: fmtNum, dir: null }
];

// The cross-release trend deliberately carries a subset: one row per release times every
// metric would be unreadable, and METHODOLOGY.md rule 5 says the trend is about the ratio
// moving, not about the absolute numbers.
const TREND_ROWS = [
    { label: 'size raw', field: 'size.raw', dir: 'lower' },
    { label: 'size gzip', field: 'size.gzip', dir: 'lower' },
    { label: 'startup noop', field: 'startup.noopMedianMs', dir: 'lower' },
    { label: 'startup +stdlib', field: 'startup.importStdlibMedianMs', dir: 'lower' },
    { label: 'baseline RSS', field: 'memory.baselineRssBytes', dir: 'lower' },
    { label: 'peak RSS', field: 'memory.workloadPeakRssBytes', dir: 'lower' },
    { label: 'mandelbrot', field: 'ops.mandelbrot', dir: 'higher' },
    { label: 'timers', field: 'ops.timers', dir: 'higher' },
    { label: 'SHA-256', field: 'ops.sha256-mbps', dir: 'higher' }
];

export function generateReport({ historyDir, latestPath = null, methodologyPath }) {
    const runs = loadRuns(historyDir, latestPath);
    const methodology = readFileSync(methodologyPath, 'utf8');
    const out = [];

    out.push('# Benchmarks\n');
    out.push(
        '<!-- Generated by benchmarks/report.mjs. Do not edit by hand -- run\n' +
        '     `node benchmarks/report.mjs` (or `--check` to verify it is current).\n' +
        '     The Methodology and Limits prose lives in benchmarks/METHODOLOGY.md. -->\n'
    );

    if (runs.length === 0) {
        out.push(emptyState());
    } else {
        out.push(overview(runs));

        const byPlatform = groupByPlatform(runs);

        out.push('## Latest run\n');

        for (const [ platform, platformRuns ] of byPlatform) {
            out.push(latestSection(platform, platformRuns[platformRuns.length - 1]));
        }

        out.push('## Trend across releases\n');
        out.push(
            'Ratios against `full` from the *same* run, per METHODOLOGY.md rule 5: absolute\n' +
            'numbers from different jobs are not comparable, the ratio is. Ordered oldest first.\n'
        );

        for (const [ platform, platformRuns ] of byPlatform) {
            out.push(trendSection(platform, platformRuns));
        }
    }

    out.push(...methodologySections(methodology));

    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function emptyState() {
    return [
        '## No benchmark runs recorded yet\n',
        '`benchmarks/history/` is empty, so there is nothing to tabulate. Per phase P5 of the plan,',
        'history is committed back only from tag runs of `bench.yml`; a local run is measured on',
        'unknown hardware against a possibly dirty tree and must not enter the store.\n',
        'To produce a result locally and regenerate this file from it without touching the store:\n',
        '```sh',
        'node benchmarks/bench.mjs --binary full=./build/tjs --binary min=./dist/min/tjs --out /tmp/bench.json',
        'node benchmarks/report.mjs --latest /tmp/bench.json',
        '```\n',
        'The methodology below applies to every run regardless.\n'
    ].join('\n');
}

function overview(runs) {
    const platforms = [ ...new Set(runs.map(r => r.platform)) ].sort();
    const newest = runs[runs.length - 1];
    const lines = [
        `${runs.length} recorded run${runs.length === 1 ? '' : 's'} across ` +
        `${platforms.length} platform${platforms.length === 1 ? '' : 's'} ` +
        `(${platforms.map(p => `\`${p}\``).join(', ')}).`,
        `Newest: **${cell(newest.version)}** on \`${cell(newest.platform)}\`, ` +
        `measured ${cell(newest.date ?? MISSING)}.\n`
    ];
    const unknown = runs.filter(r => r.schemaVersion !== KNOWN_SCHEMA);

    if (unknown.length > 0) {
        // Best-effort rendering is the contract, but silently best-effort is not: a reader
        // seeing a column of `—` deserves to know the generator did not understand the file.
        lines.push(
            `> **Note:** ${unknown.length} result file${unknown.length === 1 ? ' uses' : 's use'} a schema ` +
            `version this generator does not know (expected \`schemaVersion: ${KNOWN_SCHEMA}\`). ` +
            'Rendered best-effort; fields it cannot map show as `' + MISSING + '`. ' +
            `Affected: ${unknown.map(r => `\`${cell(r.file)}\``).join(', ')}.\n`
        );
    }

    return lines.join('\n');
}

function latestSection(platform, run) {
    const ids = binaryIds(run);
    const out = [ `### \`${cell(platform)}\` — ${cell(run.version)}\n`, provenance(run), inventoryTable(run, ids) ];

    out.push('#### Size\n');
    out.push(...comparison(run, ids, SIZE_ROWS));
    out.push('#### Startup, memory, CPU\n');
    out.push(...comparison(run, ids, RUNTIME_ROWS));

    const anyUnstable = ids.some(id =>
        RUNTIME_ROWS.some(r => r.unstable && get(run.binaries[id], r.unstable) === true));

    if (anyUnstable) {
        out.push('\\* MAD exceeds 5% of the median: unstable in this run (METHODOLOGY.md rule 4).\n');
    }

    out.push('#### Throughput\n');
    out.push(...comparison(run, ids, opsRows(run)));
    out.push(skippedNote(run, ids));

    return out.filter(Boolean).join('\n');
}

function provenance(run) {
    const flags = [];

    if (run.quick) {
        // bench.mjs's own --quick help text calls this "not a valid measurement"; the report
        // must not let a smoke run be quoted as a result.
        flags.push('**`--quick` smoke run — 5 spawns / 1 rep, not a valid measurement.**');
    }

    if (run.dirty) {
        flags.push('**Working tree was dirty — not reproducible from `commit` alone.**');
    }

    const rows = [
        [ 'commit', code(run.commit) ],
        [ 'date', run.date ? cell(run.date) : MISSING ],
        [ 'runner', joinParts([ get(run, 'runner.image'), get(run, 'runner.cpuModel'),
            optional(get(run, 'runner.cores'), n => `${n} cores`),
            optional(get(run, 'runner.memTotal'), n => `${(n / (1024 ** 3)).toFixed(1)} GiB RAM`) ]) ],
        [ 'toolchain', joinParts([ get(run, 'toolchain.cc'), get(run, 'toolchain.cmake'),
            optional(get(run, 'toolchain.node'), v => `node ${v}`) ]) ],
        [ 'sampling', joinParts([
            optional(get(run, 'config.spawns'), n => `${n} spawns`),
            optional(get(run, 'config.warmups'), n => `${n} warmups`),
            optional(get(run, 'config.reps'), n => `best of ${n} reps`),
            get(run, 'config.timeTool')
        ]) ],
        [ 'source', code(run.file) ]
    ];

    return `${flags.map(f => `${f}\n`).join('')}${table([ 'field', 'value' ], [ 'l', 'l' ], rows)}`;
}

function inventoryTable(run, ids) {
    const rows = ids.map(id => {
        const bin = run.binaries[id];
        const features = get(bin, 'features');
        const cli = get(bin, 'cli');

        return [
            `\`${cell(id)}\``,
            code(get(bin, 'path')),
            featureList(features, true),
            featureList(features, false),
            cli ? `${countTrue(cli)}/${Object.keys(cli).length}` : MISSING
        ];
    });

    return table(
        [ 'binary', 'path', 'features on', 'features off', 'CLI subcommands' ],
        [ 'l', 'l', 'l', 'l', 'r' ],
        rows
    );
}

// One absolute table plus one ratio table, always in that order, however many binaries there
// are. Interleaving `x` and `x ÷ full` columns reads better for two binaries and becomes a
// 15-column wall for seven, so the layout does not depend on how many were measured.
function comparison(run, ids, rows) {
    const out = [ valueTable(run, ids, rows) ];
    const others = ids.filter(id => id !== 'full');

    if (!run.binaries.full) {
        out.push('No `full` binary in this run, so there is nothing to normalise against.\n');

        return out;
    }

    if (others.length === 0) {
        return out;
    }

    // Rows with no better/worse direction (a MAD, a CPU-efficiency ratio) are dropped rather
    // than rendered as `—`: a dash there would read as "not measured", which is not the case.
    const ratioRows = rows.filter(r => r.dir !== null);

    out.push('Ratio vs `full` — bold marks a value more than 5% worse than `full`.\n');
    out.push(ratioTable(run, others, ratioRows));

    return out;
}

function valueTable(run, ids, rows) {
    const body = rows.map(r => [ rowLabel(r), ...ids.map(id => renderCell(run.binaries[id], r)) ]);

    return table(
        [ 'metric', ...ids.map(id => `\`${cell(id)}\``) ],
        [ 'l', ...ids.map(() => 'r') ],
        body
    );
}

function ratioTable(run, others, rows) {
    const full = run.binaries.full;
    const body = rows.map(r => [
        rowLabel(r),
        ...others.map(id => fmtRatio(rowValue(run.binaries[id], r), rowValue(full, r), r.dir))
    ]);

    return table(
        [ 'metric', ...others.map(id => `\`${cell(id)}\` ÷ \`full\``) ],
        [ 'l', ...others.map(() => 'r') ],
        body
    );
}

function rowLabel(r) {
    return r.unit ? `${cell(r.label)} (${cell(r.unit)})` : cell(r.label);
}

// The single place a metric turns into a number. A workload that bench.mjs skipped because
// its feature is compiled out is forced to null here even if `ops` somehow carries a value:
// METHODOLOGY.md rule 7 says a skipped workload never contributes a number, and enforcing
// that at the read means no downstream table can accidentally print a 0 or a ratio.
function rowValue(bin, r) {
    if (r.workload && asArray(get(bin, 'skipped')).includes(r.workload)) {
        return null;
    }

    const v = get(bin, r.field);

    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function renderCell(bin, r) {
    const text = r.fmt(rowValue(bin, r));

    return r.unstable && get(bin, r.unstable) === true ? `${text} \\*` : text;
}

function opsRows(run) {
    const known = new Set(OPS_METRICS.map(m => m.key));
    const extra = new Set();

    for (const id of Object.keys(run.binaries)) {
        for (const key of Object.keys(get(run.binaries[id], 'ops') ?? {})) {
            if (!known.has(key)) {
                extra.add(key);
            }
        }
    }

    const metrics = [
        ...OPS_METRICS,
        // A metric this generator has never heard of still gets a row; the unit is the one
        // thing it genuinely cannot know.
        ...[ ...extra ].sort().map(key => {
            return { key, label: key, unit: MISSING, workload: null };
        })
    ];

    return metrics.map(m => {
        return {
            label: m.label,
            unit: m.unit,
            field: `ops.${m.key}`,
            workload: m.workload,
            fmt: fmtOps,
            dir: 'higher'
        };
    });
}

function skippedNote(run, ids) {
    const parts = [];

    for (const id of ids) {
        const skipped = asArray(get(run.binaries[id], 'skipped'));

        if (skipped.length > 0) {
            parts.push(`\`${cell(id)}\`: ${skipped.map(w => `\`${cell(w)}\``).join(', ')}`);
        }
    }

    if (parts.length === 0) {
        return '';
    }

    return `Workloads skipped because the feature is compiled out (recorded as \`${MISSING}\`, never 0): ` +
        `${parts.join('; ')}.\n`;
}

function trendSection(platform, platformRuns) {
    const out = [ `### \`${cell(platform)}\`\n` ];

    if (platformRuns.length < 2) {
        out.push('Only one run recorded on this platform; a trend needs at least two.\n');

        return out.join('\n');
    }

    const ids = [ ...new Set(platformRuns.flatMap(binaryIds)) ]
        .filter(id => id !== 'full')
        .sort(byBinaryOrder);

    out.push('#### `full` absolute size (bytes)\n');
    out.push(
        'The one metric that is exact and machine-independent, so it is shown absolute\n' +
        'rather than as a ratio.\n'
    );
    out.push(table(
        [ 'version', 'raw', 'gzip -9' ],
        [ 'l', 'r', 'r' ],
        platformRuns.map(run => [
            cell(run.version),
            fmtBytes(rowValue(run.binaries.full, { field: 'size.raw' })),
            fmtBytes(rowValue(run.binaries.full, { field: 'size.gzip' }))
        ])
    ));

    for (const id of ids) {
        out.push(`#### \`${cell(id)}\` ÷ \`full\`\n`);
        out.push(table(
            [ 'version', ...TREND_ROWS.map(r => cell(r.label)) ],
            [ 'l', ...TREND_ROWS.map(() => 'r') ],
            platformRuns.map(run => [
                cell(run.version),
                ...TREND_ROWS.map(r => fmtRatio(
                    rowValue(run.binaries[id], r),
                    rowValue(run.binaries.full, r),
                    r.dir
                ))
            ])
        ));
    }

    return out.join('\n');
}

// The methodology prose is never duplicated here: it is read from METHODOLOGY.md and
// re-homed under two top-level sections. Everything above the file's first `##` is an
// editing note aimed at whoever maintains that file, so it is dropped.
function methodologySections(md) {
    const sections = new Map();
    let current = null;

    for (const line of md.split('\n')) {
        const m = line.match(/^##\s+(.*)$/);

        if (m) {
            current = m[1].trim();
            sections.set(current, []);
            continue;
        }

        if (current !== null) {
            sections.get(current).push(line);
        }
    }

    const take = name => {
        const body = sections.get(name);

        sections.delete(name);

        return body ? body.join('\n').trim() : null;
    };

    const limits = take('Honest limits');
    const rules = take('Rules');
    const measured = take('What is measured');
    const out = [];

    out.push('## Limits\n');
    out.push(limits ?? `${MISSING} (no "Honest limits" section in METHODOLOGY.md)\n`);
    out.push('\n## Methodology\n');
    out.push(subsection('Rules', rules));
    out.push(subsection('What is measured', measured));

    // Anything else the file grows later is carried through rather than silently dropped.
    for (const [ name, body ] of sections) {
        out.push(subsection(name, body.join('\n').trim()));
    }

    return out;
}

function subsection(name, body) {
    if (!body) {
        return '';
    }

    return `### ${name}\n\n${body}\n`;
}

function loadRuns(historyDir, latestPath) {
    const files = existsSync(historyDir) ? jsonFiles(historyDir).sort() : [];
    const runs = files.map(f => normalize(readJson(f), path.relative(path.dirname(historyDir), f)));

    if (latestPath) {
        const abs = path.resolve(latestPath);
        const extra = normalize(readJson(abs), path.basename(abs));
        // A `--latest` file is usually the run that is *about* to be committed to history/,
        // so the same measurement can legitimately be present twice. Identity is the tuple
        // that makes a datapoint unique; the history copy wins on filename only.
        const key = identity(extra);
        const i = runs.findIndex(r => identity(r) === key);

        if (i === -1) {
            runs.push(extra);
        } else {
            runs[i] = extra;
        }
    }

    return runs.sort(byRunOrder);
}

function jsonFiles(dir) {
    const out = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            out.push(...jsonFiles(full));
        } else if (entry.name.endsWith('.json')) {
            out.push(full);
        }
    }

    return out;
}

// Unparseable JSON in the store is a bug in the store, not an older schema, so it is fatal.
// Best-effort rendering covers *fields*, not files that are not results at all.
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`report: ${file} is not valid JSON: ${e.message}`, { cause: e });
    }
}

function normalize(raw, file) {
    const o = raw && typeof raw === 'object' ? raw : {};

    return {
        file: file.split(path.sep).join('/'),
        schemaVersion: typeof o.schemaVersion === 'number' ? o.schemaVersion : null,
        version: typeof o.version === 'string' && o.version ? o.version : 'unknown',
        commit: typeof o.commit === 'string' ? o.commit : null,
        date: typeof o.date === 'string' ? o.date : null,
        platform: typeof o.platform === 'string' && o.platform ? o.platform : 'unknown-platform',
        quick: o.quick === true,
        dirty: o.dirty === true,
        config: o.config,
        runner: o.runner,
        toolchain: o.toolchain,
        binaries: o.binaries && typeof o.binaries === 'object' ? o.binaries : {}
    };
}

function identity(run) {
    return [ run.platform, run.version, run.commit, run.date ].join('|');
}

// Chronological, with total-order tiebreakers so two runs sharing a date can never swap
// between generations and produce a spurious --check failure.
function byRunOrder(a, b) {
    return cmp(a.date ?? '', b.date ?? '') || cmp(a.version, b.version) || cmp(a.file, b.file);
}

function byBinaryOrder(a, b) {
    const ia = BINARY_ORDER.indexOf(a);
    const ib = BINARY_ORDER.indexOf(b);

    if (ia !== -1 && ib !== -1) {
        return ia - ib;
    }

    if (ia !== -1) {
        return -1;
    }

    if (ib !== -1) {
        return 1;
    }

    return cmp(a, b);
}

function groupByPlatform(runs) {
    const map = new Map();

    for (const run of runs) {
        if (!map.has(run.platform)) {
            map.set(run.platform, []);
        }

        map.get(run.platform).push(run);
    }

    return new Map([ ...map.entries() ].sort((a, b) => cmp(a[0], b[0])));
}

function binaryIds(run) {
    return Object.keys(run.binaries).sort(byBinaryOrder);
}

// Plain code-unit comparison, not localeCompare: the latter is locale-sensitive and would
// break byte-identical regeneration across machines.
function cmp(a, b) {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
}

function get(obj, dotted) {
    let cur = obj;

    for (const key of dotted.split('.')) {
        if (cur === null || typeof cur !== 'object') {
            return undefined;
        }

        cur = cur[key];
    }

    return cur;
}

function asArray(x) {
    return Array.isArray(x) ? x : [];
}

function featureList(features, on) {
    if (!features || typeof features !== 'object') {
        return MISSING;
    }

    const names = Object.keys(features).filter(k => Boolean(features[k]) === on).sort();

    return names.length ? names.map(n => `\`${cell(n)}\``).join(' ') : MISSING;
}

function countTrue(o) {
    return Object.values(o).filter(Boolean).length;
}

function optional(v, fn) {
    return v === null || v === undefined ? null : fn(v);
}

function joinParts(parts) {
    const kept = parts.filter(p => p !== null && p !== undefined && p !== '');

    return kept.length ? kept.map(cell).join(', ') : MISSING;
}

function code(v) {
    return v ? `\`${cell(v)}\`` : MISSING;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}

function main() {
    const { values } = parseArgs({
        options: {
            history: { type: 'string' },
            latest: { type: 'string' },
            methodology: { type: 'string' },
            out: { type: 'string' },
            check: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false }
        }
    });

    if (values.help) {
        console.log(`Usage: node benchmarks/report.mjs [options]

  --latest <path>   Fold in a result JSON that is not in history/ yet (e.g. a PR run)
  --history <dir>   History directory (default benchmarks/history)
  --methodology <f> Methodology source (default benchmarks/METHODOLOGY.md)
  --out <path>      Output file (default benchmarks/README.md)
  --check           Do not write; exit 1 if the output file differs from what would be written
`);
        process.exit(0);
    }

    const outPath = path.resolve(values.out ?? path.join(HERE, 'README.md'));
    const md = generateReport({
        historyDir: path.resolve(values.history ?? path.join(HERE, 'history')),
        latestPath: values.latest ?? null,
        methodologyPath: path.resolve(values.methodology ?? path.join(HERE, 'METHODOLOGY.md'))
    });

    if (values.check) {
        const actual = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;

        if (actual === md) {
            console.error(`report: ${rel(outPath)} is up to date`);

            return;
        }

        console.error(`report: ${rel(outPath)} is stale.`);
        console.error(diffHint(actual, md));
        console.error(`\nRegenerate with:  node ${rel(fileURLToPath(import.meta.url))}` +
            `${values.latest ? ` --latest ${values.latest}` : ''}`);
        process.exit(1);
    }

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, md);
    console.error(`report: wrote ${rel(outPath)}`);
}

function diffHint(actual, expected) {
    if (actual === null) {
        return '  the file does not exist';
    }

    const a = actual.split('\n');
    const b = expected.split('\n');

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            return `  first difference at line ${i + 1}:\n` +
                `    on disk:   ${a[i] === undefined ? '(end of file)' : JSON.stringify(a[i])}\n` +
                `    generated: ${b[i] === undefined ? '(end of file)' : JSON.stringify(b[i])}`;
        }
    }

    return '  files differ only in trailing content';
}

function rel(p) {
    return path.relative(process.cwd(), p) || p;
}
