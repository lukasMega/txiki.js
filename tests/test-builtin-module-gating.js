import assert from 'tjs:assert';

// Black-box check that the `tjs:` builtin modules a build registers match what
// tjs.engine.features advertises. This has to run out-of-process: importing an
// unregistered builtin aborts the importing script, so it cannot be probed with
// a try/catch in-process.
//
// The failure this guards against is a silent one. On a build with the feature
// compiled out, every test that imports the module aborts before its first
// assertion and is reported as passing -- 60 FFI tests "passed" on the min
// profile that way before `ffi` existed in engine.features.

const modules = [
    { feature: 'ffi', specifier: 'tjs:ffi' },
    { feature: 'sqlite', specifier: 'tjs:sqlite' },
    { feature: 'wasm', specifier: 'tjs:wasi' },
];

async function tryImport(specifier) {
    const handle = await tjs.makeTempFile(`${tjs.tmpDir}/tjs-import-XXXXXX`);

    // close() invalidates the handle's path, so keep a copy.
    const scriptPath = handle.path;
    const script = `import '${specifier}';\nconsole.log('imported');\n`;

    await handle.write(new TextEncoder().encode(script));
    await handle.close();

    try {
        const proc = tjs.spawn([ tjs.exePath, 'run', scriptPath ], { stdout: 'pipe', stderr: 'pipe' });
        const [ status, stdout ] = await Promise.all([ proc.wait(), proc.stdout.text() ]);

        return { status, imported: stdout.includes('imported') };
    } finally {
        await tjs.remove(scriptPath);
    }
}

for (const { feature, specifier } of modules) {
    const { status, imported } = await tryImport(specifier);

    assert.eq(imported, tjs.engine.features[feature],
        `${specifier} is importable iff features.${feature} (features.${feature}=${tjs.engine.features[feature]})`);

    if (tjs.engine.features[feature]) {
        assert.eq(status.exit_status, 0, `importing ${specifier} succeeds`);
    }
}

// Modules that are never gated must load on every profile, otherwise a
// mis-scoped #ifdef would show up only as unrelated tests failing.
for (const specifier of [ 'tjs:assert', 'tjs:path', 'tjs:getopts', 'tjs:hashing', 'tjs:uuid' ]) {
    const { status, imported } = await tryImport(specifier);

    assert.ok(imported, `${specifier} is present in every build`);
    assert.eq(status.exit_status, 0, `importing ${specifier} succeeds`);
}
