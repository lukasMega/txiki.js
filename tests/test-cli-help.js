import assert from 'tjs:assert';


const args = [
    tjs.exePath,
    '-h'
];
const proc = tjs.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
const stdoutStr = await proc.stdout.text();
assert.ok(stdoutStr.startsWith('Usage: '), 'returns the help');
