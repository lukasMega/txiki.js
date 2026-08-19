import assert from 'tjs:assert';
import path from 'tjs:path';


const sourcePath = path.join(import.meta.dirname, 'helpers', 'hello.js');
const compileArgs = [
    tjs.exePath,
    'compile',
    sourcePath
];
const proc = tjs.spawn(compileArgs);
const status = await proc.wait();

assert.ok(status.exit_status === 0 && status.term_signal === null, 'succeeded');

const newExe = navigator.userAgentData.platform === 'Windows' ? 'hello.exe' : 'hello';

const st = await tjs.stat(newExe);

assert.ok(st.isFile, 'is a regular file');

const proc2 = tjs.spawn(path.join(tjs.cwd, newExe), { stdout: 'pipe' });
const [ status2, stdoutStr ] = await Promise.all([ proc2.wait(), proc2.stdout.text() ]);
assert.ok(stdoutStr.match(/hello!/) !== null, 'runs');
assert.ok(status2.exit_status === 0 && status.term_signal === null, 'succeeded');

await tjs.remove(newExe);

const tmpDir = await tjs.makeTempDir(path.join(tjs.tmpDir, 'tjs-test-compile-XXXXXX'));
const compressedSource = Array.from({ length: 1000 }, (_, i) => `value-${i}`).join(',');
const compressedSourcePath = path.join(tmpDir, 'compressible.js');
const compressedExe = path.join(tmpDir,
    navigator.userAgentData.platform === 'Windows' ? 'compressible.exe' : 'compressible');

try {
    await tjs.writeFile(compressedSourcePath, `console.log('${compressedSource}'.length);`);

    const rawBytecode = tjs.engine.serialize(tjs.engine.compile(
        await tjs.readFile(compressedSourcePath),
        'compressible.js'
    ));
    const compressProc = tjs.spawn([ tjs.exePath, 'compile', compressedSourcePath, compressedExe ]);
    const compressStatus = await compressProc.wait();

    assert.eq(compressStatus.exit_status, 0, 'compression compile succeeded');

    const executable = await tjs.readFile(compressedExe);
    const magic = new TextDecoder().decode(executable.slice(-12, -4));

    assert.eq(magic, 'tx1k1.jz', 'standalone bytecode is compressed');
    assert.ok(executable.length < (await tjs.stat(tjs.exePath)).size + rawBytecode.length + 12,
        'compressed executable is smaller than raw bytecode executable');
} finally {
    await tjs.remove(tmpDir, { recursive: true });
}
