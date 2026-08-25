#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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

function binary(file) {
    const resolved = path.resolve(file);

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`binary does not exist: ${file}`);
    }

    return {
        binaryBytes: fs.statSync(resolved).size,
        sha256: sha256(resolved),
    };
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

        return {
            id: pair.id,
            label: pair.label,
            category: pair.category,
            setting: pair.setting,
            onBytes: baselineBinary.binaryBytes,
            offBytes: variant.binaryBytes,
            deltaBytes: baselineBinary.binaryBytes - variant.binaryBytes,
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

function main() {
    const { values } = parseArgs({
        options: {
            config: { type: 'string' },
            out: { type: 'string' },
            check: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h' },
        },
    });

    if (values.help || !values.config || !values.out) {
        process.stdout.write(`Usage:
  node scripts/measure-feature-costs.mjs --config <study.json> --out <result.json> [--check]

Config names one baseline binary and paired feature-off binaries. Paths resolve relative to config.
`);

        return;
    }

    const configFile = path.resolve(values.config);
    const result = measure(JSON.parse(fs.readFileSync(configFile, 'utf8')), path.dirname(configFile));
    const content = stableJson(result);
    const out = path.resolve(values.out);

    if (values.check) {
        if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== content) {
            process.stderr.write(`${values.out} is stale\n`);
            process.exitCode = 1;
        }
    } else {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, content);
        process.stdout.write(`wrote ${values.out}\n`);
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    main();
}
