import assert from 'tjs:assert';


const args = [
    tjs.exePath,
    '--foo'
];
const proc = tjs.spawn(args, { stdout: 'ignore', stderr: 'pipe' });
const stderrStr = await proc.stderr.text();
assert.ok(stderrStr.includes('unrecognized option: foo'), 'recognizes a bad option');
