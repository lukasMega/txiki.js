// Binary size metrics. The only metrics here that are exact and machine-independent.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// gzip via node's zlib rather than the gzip(1) binary: no external tool, and level 9 is
// reproducible across platforms, which `gzip -9` output framing is not (it can embed the
// original filename and mtime).
export function measureSize(binaryPath) {
    const raw = statSync(binaryPath).size;
    const gzip = gzipSync(readFileSync(binaryPath), { level: 9 }).length;
    const segments = measureSegments(binaryPath);

    return { raw, gzip, text: segments.text, data: segments.data };
}

// size(1) is absent on plenty of systems and its output format differs between GNU (Berkeley
// default: `text data bss dec hex filename`) and macOS (`__TEXT __DATA __OBJC others dec hex`).
// Unparseable or missing => null, never 0 (METHODOLOGY.md rule 7).
function measureSegments(binaryPath) {
    const r = spawnSync('size', [ binaryPath ], { encoding: 'utf8' });

    if (r.error || r.status !== 0 || !r.stdout) {
        return { text: null, data: null };
    }

    const lines = r.stdout.trim().split('\n');

    if (lines.length < 2) {
        return { text: null, data: null };
    }

    const cols = lines[1].trim().split(/\s+/).map(Number);

    if (cols.length < 2 || !Number.isFinite(cols[0]) || !Number.isFinite(cols[1])) {
        return { text: null, data: null };
    }

    return { text: cols[0], data: cols[1] };
}
