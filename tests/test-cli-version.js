import assert from 'tjs:assert';


const args = [
    tjs.exePath,
    '-v'
];
const proc = tjs.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
const stdoutStr = await proc.stdout.text();
assert.eq(stdoutStr.trim(), `v${tjs.version}`, 'returns the right version');
