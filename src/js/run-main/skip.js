/* global tjs */

import pathModule from 'tjs:internal/path';

function matchGlob(pattern, name) {
    const star = pattern.indexOf('*');

    if (star === -1) {
        return pattern === name;
    }

    return name.startsWith(pattern.slice(0, star)) && name.endsWith(pattern.slice(star + 1));
}

const PROBE = 'console.log(JSON.stringify({ features: tjs.engine.features, cli: tjs.engine.cli }));\n';

/**
 * Flatten the two gating sources feature-skip.json can key on: the CMake
 * feature flags by their own name, and the CLI gating under a `cli.` prefix
 * (`cli.eval`, `cli.bundler`, ...). They live on separate objects so that
 * `core/engine.js` carries none of the fork's CLI gating.
 */
function flagMap({ features, cli }) {
    const flags = Object.assign(Object.create(null), features);

    for (const [ name, value ] of Object.entries(cli ?? {})) {
        flags[`cli.${name}`] = value;
    }

    return flags;
}

/**
 * Ask the binary that will actually execute the tests which features it has.
 *
 * With TJS_TEST_EXE set, the host's own `tjs.engine.features` describes the
 * wrong binary: a full host driving an FFI-less artifact would happily queue
 * all the FFI tests and watch every one of them fail. Every failure mode here
 * is fatal on purpose -- guessing would either skip nothing or skip the whole
 * suite, and both look like a passing run.
 */
async function probeFeatures(exe) {
    const handle = await tjs.makeTempFile(pathModule.join(tjs.tmpDir, 'tjs-features-XXXXXX'));

    // close() invalidates the handle's path, so keep a copy.
    const tmpPath = handle.path;

    await handle.write(new TextEncoder().encode(PROBE));
    await handle.close();

    let stdout;
    let stderr;
    let status;

    try {
        const proc = tjs.spawn([ exe, 'run', tmpPath ], { stdout: 'pipe', stderr: 'pipe' });
        const out = proc.stdout.text();
        const err = proc.stderr.text();

        [ stdout, stderr, status ] = await Promise.all([ out, err, proc.wait() ]);
    } catch (e) {
        throw new Error(`TJS_TEST_EXE probe: cannot run "${exe} run": ${e.message ?? e}`, { cause: e });
    } finally {
        try {
            await tjs.remove(tmpPath);
        } catch (_) {
            // A leaked temp file must not mask the real error.
        }
    }

    if (status.exit_status !== 0 || status.term_signal !== null) {
        const how = status.term_signal !== null ? `signal ${status.term_signal}` : `status ${status.exit_status}`;

        throw new Error(`TJS_TEST_EXE probe: ${exe} exited with ${how}: ${stderr.trim() || '<no stderr>'}`);
    }

    let parsed;

    try {
        parsed = JSON.parse(stdout);
    } catch (e) {
        const got = JSON.stringify(stdout.slice(0, 200));

        throw new Error(`TJS_TEST_EXE probe: ${exe} printed no usable feature set: ${got}`, { cause: e });
    }

    const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

    // `cli` is absent on an old artifact, which the missing-key check below
    // turns into a hard error; `features` missing means the probe is not even
    // reporting the shape we asked for.
    if (!isObject(parsed) || !isObject(parsed.features)) {
        throw new Error(`TJS_TEST_EXE probe: ${exe} printed ${JSON.stringify(parsed)}, ` +
            'expected { features: {...}, cli: {...} }');
    }

    const flags = flagMap(parsed);

    // A key the host knows and the child does not means the two binaries were
    // built from different trees; the skip decision for that key would be a
    // coin flip.
    const missing = Object.keys(hostFlags()).filter(k => !(k in flags));

    if (missing.length > 0) {
        throw new Error(`TJS_TEST_EXE probe: ${exe} is missing feature keys the host has ` +
            `(${missing.join(', ')}); rebuild it from this tree`);
    }

    return flags;
}

function hostFlags() {
    return flagMap({ features: tjs.engine.features, cli: tjs.engine.cli });
}

export async function buildSkipFilter(dir) {
    const testExe = tjs.env.TJS_TEST_EXE;
    const features = testExe ? await probeFeatures(testExe) : hostFlags();
    let featureSkip = {};

    try {
        const raw = await tjs.readFile(pathModule.join(dir, 'feature-skip.json'));

        featureSkip = JSON.parse(new TextDecoder().decode(raw));
    } catch (_) {
        // No config file - skip nothing.
    }

    const skipPatterns = [];

    for (const [ feature, patterns ] of Object.entries(featureSkip)) {
        if (!(feature in features)) {
            console.log(`feature-skip.json: unknown feature "${feature}" — ignoring`);
            continue;
        }

        if (!features[feature]) {
            skipPatterns.push(...patterns);
        }
    }

    return name => skipPatterns.some(p => matchGlob(p, name));
}
