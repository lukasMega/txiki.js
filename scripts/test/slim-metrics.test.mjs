import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { FEATURE_CATALOG } from '../../website/scripts/generate-slim-metrics.mjs';
import { FEATURE_IDS, flatProbe, loadRecipe, measure } from '../measure-feature-costs.mjs';
import {
    PLATFORMS,
    PROFILES,
    collectManifest,
    parseAssetName,
    releaseRecord,
    stableJson,
    validateManifest,
} from '../release-size-manifest.mjs';

const PLATFORM_ALIASES = {
    'linux-x86_64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'macos-arm64': 'darwin-arm64',
    'windows-x86_64': 'win32-x64',
};

function features(profile) {
    const featureProfile = profile.replace(/^(balanced|tuned)-/, '');

    return {
        ffi: featureProfile === 'ffi' || featureProfile.startsWith('ffi-'),
        tls: featureProfile === 'tls' || featureProfile.includes('-tls'),
        sqlite: featureProfile === 'sqlite' || featureProfile.endsWith('-sqlite'),
    };
}

function optimization(profile) {
    if (profile.startsWith('balanced-')) {
        return 'balanced';
    }

    return profile.startsWith('tuned-') ? 'tuned' : 'smallest';
}

function fixtureTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'txiki-size-fixture-'));
    let index = 1;

    for (const platform of PLATFORMS) {
        for (const profile of PROFILES) {
            const name = `txiki-slim-${profile}-${platform}`;
            const dir = path.join(root, name);
            const vector = features(profile);

            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(root, `${name}.zip`), `archive-${index}`);
            fs.writeFileSync(path.join(dir, 'BUILDINFO.txt'), [
                `profile: fixture-${profile}`,
                `optimization: ${optimization(profile)}`,
                `features: ffi=${vector.ffi} tls=${vector.tls} sqlite=${vector.sqlite} wasm=false webcrypto=true`,
                `platform: ${PLATFORM_ALIASES[platform]}`,
                `size: ${1000000 + index}`,
                `sha256: ${index.toString(16).padStart(64, '0')}`,
                'msvc: false',
                '',
            ].join('\n'));
            index += 1;
        }
    }

    return root;
}

test('asset names preserve profile suffixes', () => {
    assert.deepEqual(parseAssetName('txiki-slim-ffi-tls-sqlite-macos-arm64.zip'), {
        profile: 'ffi-tls-sqlite',
        platform: 'macos-arm64',
    });
});

test('collector emits stable complete manifest', t => {
    const root = fixtureTree();

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = {
        inputDir: root,
        tag: 'slim-v26.6.0-9',
        commit: '1'.repeat(40),
    };
    const first = collectManifest(input);
    const second = collectManifest(input);

    assert.equal(first.artifacts.length, 32);
    assert.equal(stableJson(first), stableJson(second));
    assert.deepEqual(first.artifacts[0].features, {
        ffi: false,
        sqlite: false,
        tls: false,
        wasm: false,
        webcrypto: true,
    });
});

test('validator rejects missing and duplicate cells', t => {
    const root = fixtureTree();

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = collectManifest({
        inputDir: root,
        tag: 'slim-v26.6.0-9',
        commit: '2'.repeat(40),
    });

    assert.throws(() => validateManifest({ ...manifest, artifacts: manifest.artifacts.slice(1) }), /missing/);
    assert.throws(
        () => validateManifest({ ...manifest, artifacts: [ ...manifest.artifacts, manifest.artifacts[0] ] }),
        /duplicate/
    );
});

test('validator permits explicit partial historic releases', t => {
    const root = fixtureTree();

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = collectManifest({
        inputDir: root,
        tag: 'slim-v26.6.0-9',
        commit: '5'.repeat(40),
    });
    const partial = {
        ...manifest,
        artifacts: manifest.artifacts.filter(artifact => ![ 'balanced-min', 'tuned-min' ].includes(artifact.profile)),
    };

    assert.throws(() => validateManifest(partial), /missing/);
    const validated = validateManifest(partial, { allowPartial: true });

    assert.equal(validated.complete, false);
    assert.equal(validated.artifacts.length, 24);
});

test('release metadata must match archive sizes', t => {
    const root = fixtureTree();

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = collectManifest({
        inputDir: root,
        tag: 'slim-v26.6.0-9',
        commit: '3'.repeat(40),
    });
    const metadata = {
        tag_name: manifest.tag,
        published_at: '2026-08-25T12:00:00Z',
        assets: manifest.artifacts.map(artifact => {
            return { name: artifact.asset, size: artifact.archiveBytes };
        }),
    };

    assert.equal(releaseRecord({ manifest, metadata }).publishedAt, '2026-08-25T12:00:00.000Z');
    metadata.assets[0].size += 1;
    assert.throws(() => releaseRecord({ manifest, metadata }), /disagrees/);
});

test('feature collector measures paired binaries', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'txiki-feature-fixture-'));

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'with-tls'), '1234567890');
    fs.writeFileSync(path.join(root, 'without-tls'), '123456');
    const result = measure({
        schemaVersion: 1,
        id: 'fixture-linux',
        commit: '4'.repeat(40),
        date: '2026-08-25T12:00:00Z',
        platform: 'linux-x86_64',
        recipe: 'fixture-v1',
        baseline: { path: 'with-tls', features: { tls: true } },
        pairs: [ {
            id: 'tls',
            path: 'without-tls',
            label: 'TLS',
            category: 'runtime',
            setting: 'BUILD_WITH_TLS=OFF',
            features: { tls: false },
        } ],
    }, root);

    assert.equal(result.pairs[0].deltaBytes, 4);
    assert.deepEqual(result.pairs[0].changedFeatures, [ 'tls' ]);
});

const RECIPE_FILE = path.join(import.meta.dirname, '..', 'feature-study-v1.json');

test('recipe, recorder and website catalog name the same features', () => {
    const recipe = loadRecipe(RECIPE_FILE);

    assert.deepEqual([ ...FEATURE_IDS ].sort(), FEATURE_CATALOG.map(entry => entry.id).sort());
    assert.deepEqual(recipe.pairs.map(pair => pair.id).sort(), [ ...FEATURE_IDS ].sort());

    // The chart groups by category and labels by label, so a recipe that
    // disagreed would silently file a bar under the wrong selector.
    for (const entry of FEATURE_CATALOG) {
        const pair = recipe.pairs.find(candidate => candidate.id === entry.id);

        assert.equal(pair.label, entry.label, `${entry.id} label`);
        assert.equal(pair.category, entry.category, `${entry.id} category`);
        assert.equal(pair.setting, entry.setting, `${entry.id} setting`);
    }
});

test('recipe declares a probe for every switch it can observe', () => {
    const recipe = loadRecipe(RECIPE_FILE);
    const baseline = flatProbe(recipe.baseline.probe);

    assert.ok(Object.values(baseline).every(value => value === true), 'baseline must have every feature on');

    for (const pair of recipe.pairs) {
        if (pair.probe === null) {
            assert.ok(pair.probeNote, `${pair.id} has no probe and must say why`);
            continue;
        }

        const expected = flatProbe(pair.probe);
        const keys = Object.keys(expected);

        assert.ok(keys.length > 0, `${pair.id} probe is empty`);

        for (const key of keys) {
            assert.ok(key in baseline, `${pair.id} probes ${key}, which the baseline never reports`);
            assert.equal(expected[key], false, `${pair.id} probe ${key} must be false`);
        }
    }
});

test('recipe declares companion changes wherever a switch drags another along', () => {
    const recipe = loadRecipe(RECIPE_FILE);
    const byId = new Map(recipe.pairs.map(pair => [ pair.id, pair ]));

    // Turning TLS off forces the bundled CA and the --tls-ca option off with it,
    // so its bar contains all three costs and must say so.
    assert.deepEqual(byId.get('tls').companionChanges, [ 'bundled-ca', 'tls-ca' ]);
    assert.equal(byId.get('bundled-ca').cmake.BUILD_WITH_BUNDLED_CA, 'OFF');
    assert.equal(byId.get('bundled-ca').cmake.BUILD_WITH_TLS, undefined, 'bundled-ca must keep TLS on');

    // The REPL is the one CLI entry with a C half; both must move together.
    assert.equal(byId.get('repl').cmake.BUILD_WITH_REPL, 'OFF');
    assert.equal(byId.get('repl').defines.__TJS_REPL__, 'false');
});

test('recipe rejects a pair with no probe key at all', () => {
    const recipe = JSON.parse(fs.readFileSync(RECIPE_FILE, 'utf8'));

    delete recipe.pairs[0].probe;
    const broken = path.join(os.tmpdir(), `txiki-recipe-${process.pid}.json`);

    fs.writeFileSync(broken, JSON.stringify(recipe));
    assert.throws(() => loadRecipe(broken), /declares no probe/);
    fs.rmSync(broken, { force: true });
});
