#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const PROFILES = [
    'balanced-min',
    'tuned-min',
    'min',
    'ffi',
    'tls',
    'sqlite',
    'ffi-tls',
    'ffi-tls-sqlite',
];

export const PLATFORMS = [
    'linux-x86_64',
    'linux-arm64',
    'macos-arm64',
    'windows-x86_64',
];

const REPOSITORY = 'lukasMega/txiki.js-with-slim-builds';
const ASSET_PREFIX = 'txiki-slim-';
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

function fail(message) {
    throw new Error(message);
}

export function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseAssetName(name) {
    if (!name.startsWith(ASSET_PREFIX) || !name.endsWith('.zip')) {
        return null;
    }

    const stem = name.slice(ASSET_PREFIX.length, -4);

    for (const platform of PLATFORMS) {
        const suffix = `-${platform}`;

        if (!stem.endsWith(suffix)) {
            continue;
        }

        const profile = stem.slice(0, -suffix.length);

        if (!PROFILES.includes(profile)) {
            fail(`unknown profile in release asset ${name}`);
        }

        return { profile, platform };
    }

    fail(`unknown platform in release asset ${name}`);
}

export function parseBuildInfo(text) {
    const fields = {};

    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([a-z][a-z0-9]*):\s*(.*?)\s*$/i);

        if (match) {
            fields[match[1].toLowerCase()] = match[2];
        }
    }

    const size = Number(fields.size);

    if (!Number.isSafeInteger(size) || size <= 0) {
        fail(`invalid BUILDINFO size ${JSON.stringify(fields.size)}`);
    }

    if (!SHA256_RE.test(fields.sha256 ?? '')) {
        fail('invalid BUILDINFO sha256');
    }

    const features = {};

    for (const token of (fields.features ?? '').split(/\s+/).filter(Boolean)) {
        const match = token.match(/^([a-z][a-z0-9-]*)=(true|false)$/);

        if (!match) {
            fail(`invalid BUILDINFO feature ${JSON.stringify(token)}`);
        }

        features[match[1]] = match[2] === 'true';
    }

    for (const key of [ 'ffi', 'tls', 'sqlite', 'wasm' ]) {
        if (typeof features[key] !== 'boolean') {
            fail(`BUILDINFO lacks ${key} feature`);
        }
    }

    return {
        platform: fields.platform,
        optimization: fields.optimization,
        binaryBytes: size,
        binarySha256: fields.sha256,
        features,
    };
}

function expectedOptimization(profile) {
    if (profile === 'balanced-min') {
        return 'balanced';
    }

    if (profile === 'tuned-min') {
        return 'tuned';
    }

    return 'smallest';
}

function expectedFeatures(profile) {
    const featureProfile = profile.replace(/^(balanced|tuned)-/, '');

    return {
        ffi: featureProfile === 'ffi' || featureProfile.startsWith('ffi-'),
        tls: featureProfile === 'tls' || featureProfile.includes('-tls'),
        sqlite: featureProfile === 'sqlite' || featureProfile.endsWith('-sqlite'),
        wasm: false,
    };
}

function buildPlatformMatches(platform, buildPlatform) {
    const aliases = {
        'linux-x86_64': 'linux-x64',
        'linux-arm64': 'linux-arm64',
        'macos-arm64': 'darwin-arm64',
        'windows-x86_64': 'win32-x64',
    };

    return !buildPlatform || aliases[platform] === buildPlatform;
}

export function artifactFromBuildInfo({ name, archiveBytes, buildInfo }) {
    const parsedName = parseAssetName(name);

    if (!parsedName) {
        fail(`not a slim ZIP asset: ${name}`);
    }

    const info = parseBuildInfo(buildInfo);
    const optimization = info.optimization ?? expectedOptimization(parsedName.profile);
    const wantedFeatures = expectedFeatures(parsedName.profile);

    if (optimization !== expectedOptimization(parsedName.profile)) {
        fail(`${name} reports optimization ${optimization}`);
    }

    if (!buildPlatformMatches(parsedName.platform, info.platform)) {
        fail(`${name} reports platform ${info.platform}`);
    }

    for (const [ key, value ] of Object.entries(wantedFeatures)) {
        if (info.features[key] !== value) {
            fail(`${name} reports ${key}=${info.features[key]}, expected ${value}`);
        }
    }

    if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
        fail(`invalid archive size for ${name}`);
    }

    return {
        platform: parsedName.platform,
        profile: parsedName.profile,
        optimization,
        asset: name,
        archiveBytes,
        binaryBytes: info.binaryBytes,
        binarySha256: info.binarySha256,
        features: Object.fromEntries(Object.entries(info.features).sort(([ a ], [ b ]) => a.localeCompare(b))),
    };
}

function artifactOrder(artifact) {
    return PLATFORMS.indexOf(artifact.platform) * PROFILES.length + PROFILES.indexOf(artifact.profile);
}

export function validateManifest(manifest, { allowPartial = false } = {}) {
    if (manifest.schemaVersion !== 1) {
        fail(`unsupported size-manifest schema ${manifest.schemaVersion}`);
    }

    if (!/^slim-v\d+\.\d+\.\d+-\d+$/.test(manifest.tag ?? '')) {
        fail(`invalid release tag ${JSON.stringify(manifest.tag)}`);
    }

    if (!COMMIT_RE.test(manifest.commit ?? '')) {
        fail(`invalid release commit ${JSON.stringify(manifest.commit)}`);
    }

    if (!Array.isArray(manifest.artifacts)) {
        fail('size manifest lacks artifacts');
    }

    const cells = new Set();

    for (const artifact of manifest.artifacts) {
        const parsed = parseAssetName(artifact.asset);

        if (!parsed || parsed.platform !== artifact.platform || parsed.profile !== artifact.profile) {
            fail(`asset coordinates disagree for ${artifact.asset}`);
        }

        if (artifact.optimization !== expectedOptimization(artifact.profile)) {
            fail(`invalid optimization for ${artifact.asset}`);
        }

        for (const key of [ 'archiveBytes', 'binaryBytes' ]) {
            if (!Number.isSafeInteger(artifact[key]) || artifact[key] <= 0) {
                fail(`invalid ${key} for ${artifact.asset}`);
            }
        }

        if (!SHA256_RE.test(artifact.binarySha256 ?? '')) {
            fail(`invalid binarySha256 for ${artifact.asset}`);
        }

        const wantedFeatures = expectedFeatures(artifact.profile);

        for (const [ key, value ] of Object.entries(wantedFeatures)) {
            if (artifact.features?.[key] !== value) {
                fail(`invalid ${key} feature for ${artifact.asset}`);
            }
        }

        const cell = `${artifact.platform}/${artifact.profile}`;

        if (cells.has(cell)) {
            fail(`duplicate artifact cell ${cell}`);
        }

        cells.add(cell);
    }

    const expectedCount = PLATFORMS.length * PROFILES.length;

    if (!allowPartial && cells.size !== expectedCount) {
        const missing = [];

        for (const platform of PLATFORMS) {
            for (const profile of PROFILES) {
                const cell = `${platform}/${profile}`;

                if (!cells.has(cell)) {
                    missing.push(cell);
                }
            }
        }

        fail(`release needs ${expectedCount} artifacts; missing ${missing.join(', ')}`);
    }

    return {
        schemaVersion: 1,
        tag: manifest.tag,
        commit: manifest.commit,
        ...(cells.size === expectedCount ? {} : { complete: false }),
        artifacts: [ ...manifest.artifacts ].sort((a, b) => artifactOrder(a) - artifactOrder(b)),
    };
}

export function collectManifest({ inputDir, tag, commit }) {
    const artifacts = [];

    for (const name of fs.readdirSync(inputDir).sort()) {
        if (!fs.statSync(path.join(inputDir, name)).isDirectory()) {
            continue;
        }

        if (!parseAssetName(`${name}.zip`)) {
            continue;
        }

        const zipPath = path.join(inputDir, `${name}.zip`);
        const infoPath = path.join(inputDir, name, 'BUILDINFO.txt');

        if (!fs.existsSync(zipPath) || !fs.existsSync(infoPath)) {
            fail(`${name} lacks ZIP or BUILDINFO.txt`);
        }

        artifacts.push(artifactFromBuildInfo({
            name: `${name}.zip`,
            archiveBytes: fs.statSync(zipPath).size,
            buildInfo: fs.readFileSync(infoPath, 'utf8'),
        }));
    }

    return validateManifest({ schemaVersion: 1, tag, commit, artifacts });
}

export function releaseRecord({ manifest, metadata, allowPartial = false }) {
    const clean = validateManifest(manifest, { allowPartial });

    if (metadata.tag_name !== clean.tag) {
        fail(`release metadata tag ${metadata.tag_name} does not match ${clean.tag}`);
    }

    if (!metadata.published_at || Number.isNaN(Date.parse(metadata.published_at))) {
        fail('release metadata lacks published_at');
    }

    const sizes = new Map(
        (metadata.assets ?? []).filter(asset => parseAssetName(asset.name)).map(asset => [ asset.name, asset.size ])
    );

    for (const artifact of clean.artifacts) {
        if (sizes.get(artifact.asset) !== artifact.archiveBytes) {
            fail(`GitHub archive size disagrees for ${artifact.asset}`);
        }
    }

    return {
        ...clean,
        publishedAt: new Date(metadata.published_at).toISOString(),
    };
}

async function github(pathname) {
    const headers = {
        accept: 'application/vnd.github+json',
        'user-agent': 'txiki-slim-size-updater',
        'x-github-api-version': '2022-11-28',
    };

    if (process.env.GH_TOKEN) {
        headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
    }

    const response = await fetch(`https://api.github.com${pathname}`, { headers });

    if (!response.ok) {
        fail(`GitHub ${response.status}: ${await response.text()}`);
    }

    return response;
}

async function githubJson(pathname) {
    return (await github(pathname)).json();
}

async function downloadText(url) {
    const response = await fetch(url, { headers: { 'user-agent': 'txiki-slim-size-updater' } });

    if (!response.ok) {
        fail(`download ${response.status}: ${url}`);
    }

    return response.text();
}

async function legacyManifest(metadata, commit) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txiki-slim-release-'));
    const artifacts = [];
    const checksumAsset = metadata.assets.find(asset => asset.name === 'SHA256SUMS.txt');

    if (!checksumAsset) {
        fail(`${metadata.tag_name} lacks SHA256SUMS.txt`);
    }

    const checksumText = await downloadText(checksumAsset.browser_download_url);
    const checksums = new Map(checksumText.trim().split(/\r?\n/).map(line => {
        const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);

        if (!match) {
            fail(`invalid release checksum line ${JSON.stringify(line)}`);
        }

        return [ match[2], match[1] ];
    }));

    try {
        for (const asset of metadata.assets ?? []) {
            if (!parseAssetName(asset.name)) {
                continue;
            }

            const archive = path.join(tempDir, asset.name);
            const response = await fetch(asset.browser_download_url, {
                headers: { 'user-agent': 'txiki-slim-size-updater' },
            });

            if (!response.ok) {
                fail(`download ${response.status}: ${asset.name}`);
            }

            fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

            if (fs.statSync(archive).size !== asset.size) {
                fail(`downloaded archive size disagrees for ${asset.name}`);
            }

            const listing = spawnSync('unzip', [ '-Z1', archive ], { encoding: 'utf8', shell: false });

            if (listing.status !== 0) {
                fail(`cannot list ${asset.name}: ${listing.stderr}`);
            }

            const infoEntry = listing.stdout.split(/\r?\n/).find(entry => entry.endsWith('/BUILDINFO.txt'));

            if (!infoEntry) {
                fail(`${asset.name} lacks BUILDINFO.txt`);
            }

            const info = spawnSync('unzip', [ '-p', archive, infoEntry ], { encoding: 'utf8', shell: false });

            if (info.status !== 0) {
                fail(`cannot read BUILDINFO.txt from ${asset.name}`);
            }

            const artifact = artifactFromBuildInfo({
                name: asset.name,
                archiveBytes: asset.size,
                buildInfo: info.stdout,
            });
            const binaryName = artifact.platform === 'windows-x86_64' ? 'tjs.exe' : 'tjs';
            const checksumPath = `${asset.name.slice(0, -4)}/${binaryName}`;

            if (checksums.get(checksumPath) !== artifact.binarySha256) {
                fail(`SHA256SUMS.txt disagrees for ${asset.name}`);
            }

            artifacts.push(artifact);
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    return validateManifest({ schemaVersion: 1, tag: metadata.tag_name, commit, artifacts }, { allowPartial: true });
}

async function importRelease(tag) {
    const encoded = encodeURIComponent(tag);
    const metadata = await githubJson(`/repos/${REPOSITORY}/releases/tags/${encoded}`);
    const commitInfo = await githubJson(`/repos/${REPOSITORY}/commits/${encoded}`);
    const manifestAsset = metadata.assets.find(asset => asset.name === 'slim-sizes-v1.json');
    let manifest;
    let allowPartial = false;

    if (manifestAsset) {
        manifest = JSON.parse(await downloadText(manifestAsset.browser_download_url));
    } else {
        process.stderr.write(`warning: ${tag} predates slim-sizes-v1.json; reading ZIP files\n`);
        manifest = await legacyManifest(metadata, commitInfo.sha);
        allowPartial = true;
    }

    return releaseRecord({ manifest, metadata, allowPartial });
}

function writeImmutable(file, value) {
    const content = stableJson(value);

    if (fs.existsSync(file)) {
        const current = fs.readFileSync(file, 'utf8');

        if (current !== content) {
            fail(`${file} already exists with different release data`);
        }

        process.stdout.write(`unchanged ${file}\n`);

        return;
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;

    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
    process.stdout.write(`wrote ${file}\n`);
}

function usage() {
    process.stdout.write(`Usage:
  node scripts/release-size-manifest.mjs collect --input <dist> --tag <tag> --commit <sha> --out <file>
  node scripts/release-size-manifest.mjs import --release <tag> [--out <file>]
  node scripts/release-size-manifest.mjs import --manifest <file> --metadata <file> [--out <file>]
`);
}

async function main() {
    const command = process.argv[2];
    const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
            input: { type: 'string' },
            tag: { type: 'string' },
            commit: { type: 'string' },
            out: { type: 'string' },
            release: { type: 'string' },
            manifest: { type: 'string' },
            metadata: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: false,
    });

    if (values.help || !command) {
        usage();

        return;
    }

    if (command === 'collect') {
        if (!values.input || !values.tag || !values.commit || !values.out) {
            fail('collect needs --input, --tag, --commit, and --out');
        }

        const manifest = collectManifest({ inputDir: values.input, tag: values.tag, commit: values.commit });

        fs.writeFileSync(values.out, stableJson(manifest));
        process.stdout.write(`wrote ${values.out}\n`);

        return;
    }

    if (command !== 'import') {
        fail(`unknown command ${command}`);
    }

    let record;

    if (values.release) {
        record = await importRelease(values.release);
    } else if (values.manifest && values.metadata) {
        record = releaseRecord({
            manifest: JSON.parse(fs.readFileSync(values.manifest, 'utf8')),
            metadata: JSON.parse(fs.readFileSync(values.metadata, 'utf8')),
            allowPartial: true,
        });
    } else {
        fail('import needs --release or both --manifest and --metadata');
    }

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const output = values.out ?? path.join(root, 'website', 'data', 'slim-metrics', 'releases', `${record.tag}.json`);

    writeImmutable(output, record);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    main().catch(error => {
        process.stderr.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    });
}
