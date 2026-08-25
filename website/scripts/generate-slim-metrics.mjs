#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(WEBSITE, '..');
const RELEASES_DIR = path.join(WEBSITE, 'data', 'slim-metrics', 'releases');
const FEATURE_DIR = path.join(WEBSITE, 'data', 'slim-metrics', 'feature-costs');
const BENCHMARKS_DIR = path.join(ROOT, 'benchmarks', 'history');
const OUTPUT = path.join(WEBSITE, 'src', 'data', 'slim-metrics.generated.json');

const PLATFORMS = [ 'linux-x86_64', 'linux-arm64', 'macos-arm64', 'windows-x86_64' ];
const PROFILES = [
    'balanced-min',
    'tuned-min',
    'min',
    'ffi',
    'tls',
    'sqlite',
    'ffi-tls',
    'ffi-tls-sqlite',
];

const FEATURE_CATALOG = [
    { id: 'wasm', label: 'WebAssembly', category: 'runtime', setting: 'BUILD_WITH_WASM=OFF' },
    { id: 'sqlite', label: 'SQLite', category: 'runtime', setting: 'BUILD_WITH_SQLITE=OFF' },
    { id: 'tls', label: 'TLS', category: 'runtime', setting: 'BUILD_WITH_TLS=OFF' },
    { id: 'bundled-ca', label: 'Bundled CA', category: 'runtime', setting: 'BUILD_WITH_BUNDLED_CA=OFF' },
    { id: 'webcrypto', label: 'WebCrypto', category: 'runtime', setting: 'BUILD_WITH_WEBCRYPTO=OFF' },
    { id: 'ffi', label: 'FFI', category: 'runtime', setting: 'BUILD_WITH_FFI=OFF' },
    { id: 'mimalloc', label: 'mimalloc', category: 'runtime', setting: 'BUILD_WITH_MIMALLOC=OFF' },
    { id: 'repl', label: 'REPL', category: 'cli', setting: 'BUILD_WITH_REPL=OFF + __TJS_REPL__=false' },
    { id: 'wasm-full', label: 'Full WAMR', category: 'wasm', setting: 'BUILD_WITH_WASM_FULL=OFF' },
    { id: 'xhr', label: 'XMLHttpRequest', category: 'polyfill', setting: '__TJS_XHR__=false' },
    { id: 'eval', label: 'eval command', category: 'cli', setting: '__TJS_EVAL__=false' },
    { id: 'serve', label: 'serve command', category: 'cli', setting: '__TJS_SERVE__=false' },
    { id: 'bundler', label: 'bundle command', category: 'cli', setting: '__TJS_BUNDLER__=false' },
    { id: 'test-runner', label: 'test command', category: 'cli', setting: '__TJS_TEST_RUNNER__=false' },
    { id: 'compile', label: 'compile command', category: 'cli', setting: '__TJS_COMPILE__=false' },
    { id: 'app', label: 'app command', category: 'cli', setting: '__TJS_APP__=false' },
    { id: 'help', label: 'help text', category: 'cli', setting: '__TJS_HELP__=false' },
    { id: 'tls-ca', label: '--tls-ca option', category: 'cli', setting: '__TJS_TLS_CA__=false' },
];

const SPEED_METRICS = [
    { id: 'startup-stdlib', label: 'Startup + stdlib', unit: '× full time', direction: 'lower', field: [ 'startup', 'importStdlibMedianMs' ] },
    { id: 'json-parse', label: 'JSON.parse', unit: '× full throughput', direction: 'higher', field: [ 'ops', 'json-parse' ] },
    { id: 'mandelbrot', label: 'Mandelbrot', unit: '× full throughput', direction: 'higher', field: [ 'ops', 'mandelbrot' ] },
    { id: 'timers', label: 'Timers', unit: '× full throughput', direction: 'higher', field: [ 'ops', 'timers' ] },
];

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function jsonFiles(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }

    return fs.readdirSync(dir, { withFileTypes: true })
        .flatMap(entry => {
            const target = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                return jsonFiles(target);
            }

            return entry.isFile() && entry.name.endsWith('.json') ? [ target ] : [];
        })
        .sort();
}

function get(object, fields) {
    let value = object;

    for (const field of fields) {
        value = value?.[field];
    }

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function releaseSizes() {
    const releases = jsonFiles(RELEASES_DIR).map(readJson).sort((a, b) => {
        return a.publishedAt.localeCompare(b.publishedAt) || a.tag.localeCompare(b.tag);
    });

    for (const release of releases) {
        if (release.schemaVersion !== 1 || !Array.isArray(release.artifacts)) {
            throw new Error(`unsupported release-size data for ${release.tag ?? 'unknown'}`);
        }

        if (release.complete !== false && release.artifacts.length !== PLATFORMS.length * PROFILES.length) {
            throw new Error(`${release.tag} lacks complete 8 x 4 artifact matrix`);
        }
    }

    return {
        platforms: PLATFORMS,
        profiles: PROFILES,
        releases: releases.map(release => ({
            tag: release.tag,
            commit: release.commit,
            publishedAt: release.publishedAt,
            complete: release.complete !== false,
            artifacts: release.artifacts.map(artifact => ({
                platform: artifact.platform,
                profile: artifact.profile,
                raw: artifact.binaryBytes,
                archive: artifact.archiveBytes,
            })),
        })),
    };
}

function derivedFeatureStudies(sizeData) {
    return sizeData.releases.flatMap(release => PLATFORMS.map(platform => {
        const artifacts = new Map(
            release.artifacts.filter(item => item.platform === platform).map(item => [ item.profile, item ])
        );
        const baseline = artifacts.get('min');
        if (!baseline) {
            return null;
        }

        const pairs = [
            [ 'ffi', artifacts.get('ffi') ],
            [ 'tls', artifacts.get('tls') ],
            [ 'sqlite', artifacts.get('sqlite') ],
        ].flatMap(([ id, artifact ]) => artifact ? [{
                id,
                onBytes: artifact.raw,
                offBytes: baseline.raw,
                deltaBytes: artifact.raw - baseline.raw,
                source: `${artifact.profile} minus min`,
            }] : []);

        return {
            id: `${release.tag}-${platform}-published-profiles`,
            tag: release.tag,
            commit: release.commit,
            platform,
            recipe: 'published-profile-pairs',
            provenance: 'Released artifacts; identical release and platform',
            pairs,
        };
    }).filter(study => study !== null));
}

function featureCosts(sizeData) {
    const recorded = jsonFiles(FEATURE_DIR).map(readJson);
    const studies = [ ...derivedFeatureStudies(sizeData), ...recorded ].sort((a, b) => a.id.localeCompare(b.id));
    const measured = new Set(studies.flatMap(study => study.pairs.map(pair => pair.id)));

    return {
        catalog: FEATURE_CATALOG.map(feature => ({ ...feature, measured: measured.has(feature.id) })),
        studies,
    };
}

function speed() {
    const runs = jsonFiles(BENCHMARKS_DIR).map(readJson).filter(run => run.schemaVersion === 1);

    return {
        profiles: PROFILES,
        metrics: SPEED_METRICS.map(({ field: _field, ...metric }) => metric),
        runs: runs.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform)).map(run => {
            const full = run.binaries?.full;
            const profiles = {};

            for (const profile of PROFILES) {
                const binary = run.binaries?.[profile];

                if (!binary || !full) {
                    profiles[profile] = null;
                    continue;
                }

                profiles[profile] = Object.fromEntries(SPEED_METRICS.map(metric => {
                    const reference = get(full, metric.field);
                    const value = get(binary, metric.field);
                    const ratio = reference && value !== null ? value / reference : null;

                    return [ metric.id, ratio ];
                }));
            }

            return {
                version: run.version,
                commit: run.commit,
                date: run.date,
                platform: run.platform,
                quick: run.quick,
                runner: run.runner,
                toolchain: run.toolchain,
                sampling: run.config,
                profiles,
            };
        }),
    };
}

export function generate() {
    const sizes = releaseSizes();

    return `${JSON.stringify({
        schemaVersion: 1,
        releaseSizes: sizes,
        featureCosts: featureCosts(sizes),
        speed: speed(),
    }, null, 2)}\n`;
}

const { values } = parseArgs({
    options: {
        check: { type: 'boolean', default: false },
        out: { type: 'string', default: OUTPUT },
    },
});
const generated = generate();

if (values.check) {
    const current = fs.existsSync(values.out) ? fs.readFileSync(values.out, 'utf8') : '';

    if (current !== generated) {
        process.stderr.write(`${path.relative(ROOT, values.out)} is stale; run generate-slim-metrics.mjs\n`);
        process.exitCode = 1;
    }
} else {
    fs.mkdirSync(path.dirname(values.out), { recursive: true });
    fs.writeFileSync(values.out, generated);
    process.stdout.write(`wrote ${path.relative(ROOT, values.out)}\n`);
}
