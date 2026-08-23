// Provenance: everything the report needs to say *what* was measured and *where*.
// Recorded verbatim into the result JSON so a surprising number can be explained later
// rather than re-litigated.

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { gitCapture } from './proc.mjs';

const ARCH_ALIASES = { x64: 'x86_64', arm64: 'arm64' };

export function platformId() {
    const sys = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform] ?? process.platform;

    return `${sys}-${ARCH_ALIASES[process.arch] ?? process.arch}`;
}

export function runnerInfo() {
    const cpus = os.cpus();

    return {
        image: process.env.ImageOS ?? process.env.RUNNER_IMAGE ?? null,
        ci: Boolean(process.env.CI),
        cpuModel: cpus.length ? cpus[0].model : null,
        cores: cpus.length,
        memTotal: os.totalmem(),
        release: os.release()
    };
}

export function toolchainInfo() {
    return {
        cc: firstLine(process.env.CC ?? 'cc', [ '--version' ]),
        cmake: firstLine('cmake', [ '--version' ]),
        node: process.version
    };
}

function firstLine(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });

    if (r.error || r.status !== 0 || !r.stdout) {
        return null;
    }

    return r.stdout.split('\n')[0].trim();
}

export function repoInfo(repoRoot) {
    return {
        commit: gitCapture([ 'rev-parse', 'HEAD' ], repoRoot),
        // --always so a shallow CI checkout with no tags still yields something.
        version: gitCapture([ 'describe', '--tags', '--always', '--dirty' ], repoRoot),
        dirty: gitCapture([ 'status', '--porcelain' ], repoRoot) !== ''
    };
}

const PROBE = fileURLToPath(new URL('./probe-features.js', import.meta.url));

// The feature vector of the binary under test, not of the host. Every gating decision the
// driver makes reads this -- see the fork's TJS_TEST_EXE discipline in CLAUDE.md, which is
// the same rule: probe the artifact, never assume the host.
//
// Every failure here is fatal on purpose. A driver that guesses would either benchmark a
// compiled-out feature (a crash reported as a slow run) or silently skip everything, and
// both look like a successful benchmark pass.
export function readFeatures(exe) {
    const r = spawnSync(exe, [ 'run', PROBE ], { encoding: 'utf8' });

    if (r.error || r.status !== 0) {
        throw new Error(`could not probe ${exe}: ${r.stderr?.trim() || r.error?.message}`);
    }

    let parsed;

    try {
        parsed = JSON.parse(r.stdout.trim());
    } catch {
        throw new Error(`${exe} printed unparseable probe output: ${JSON.stringify(r.stdout)}`);
    }

    if (!parsed?.features || Object.keys(parsed.features).length === 0) {
        throw new Error(`${exe} reported an empty feature vector; refusing to benchmark it`);
    }

    // `cli` is undefined in a Worker and on any build that never evaluates run-main; on a
    // CLI binary it must be there. Null it explicitly rather than letting `undefined`
    // vanish through JSON.stringify into a missing key the report cannot distinguish
    // from "not measured".
    return { features: parsed.features, cli: parsed.cli ?? null };
}
