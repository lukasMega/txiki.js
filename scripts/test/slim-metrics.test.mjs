import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { measure } from '../measure-feature-costs.mjs';
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
