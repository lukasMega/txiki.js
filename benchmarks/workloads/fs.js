/* global tjs */

import path from 'tjs:path';

import { report } from './prng.js';

// File I/O churn through libuv's threadpool.
//
// Note there is no `tjs:fs` stdlib module -- the filesystem API lives on the `tjs` global
// (tjs.writeFile / readFile / stat / readDir / makeTempDir). Importing a nonexistent
// `tjs:` module currently aborts the process with **exit status 0** and no output, so an
// early draft of this file "passed" while measuring nothing at all. That is the bug the
// uncommitted upstream PR in .claude/plans/archive/2026-08-19_upstream-pr-silent-module-load.md
// fixes; until it lands, treat an empty BENCH output as a failed import, not as no work.
//
// Everything happens in a private temp dir removed on every exit path: a benchmark that
// left droppings in the repo would surface as a dirty tree in the `codegen` job on some
// later, unrelated PR.

const FILES = 300;
const CONTENT = new TextEncoder().encode('x'.repeat(8192));
const dir = await tjs.makeTempDir(path.join(tjs.tmpDir, 'tjs-bench-fs-XXXXXX'));

try {
    {
        const t0 = performance.now();

        for (let i = 0; i < FILES; i++) {
            await tjs.writeFile(path.join(dir, `f${i}.bin`), CONTENT);
        }

        report('fs-write', FILES, performance.now() - t0);
    }

    {
        const t0 = performance.now();
        let bytes = 0;

        for (let i = 0; i < FILES; i++) {
            bytes += (await tjs.readFile(path.join(dir, `f${i}.bin`))).byteLength;
        }

        globalThis.__benchSink = bytes;
        report('fs-read', FILES, performance.now() - t0);
    }

    {
        const t0 = performance.now();
        let bytes = 0;

        for (let rep = 0; rep < 5; rep++) {
            for (let i = 0; i < FILES; i++) {
                bytes += (await tjs.stat(path.join(dir, `f${i}.bin`))).size;
            }
        }

        globalThis.__benchSink = bytes;
        report('fs-stat', FILES * 5, performance.now() - t0);
    }

    {
        const t0 = performance.now();
        let entries = 0;

        for (let rep = 0; rep < 20; rep++) {
            const it = await tjs.readDir(dir);

            for await (const _ of it) {
                entries++;
            }
        }

        if (entries !== FILES * 20) {
            throw new Error(`readDir saw ${entries} entries, expected ${FILES * 20}`);
        }

        report('fs-readdir', 20, performance.now() - t0);
    }
} finally {
    await tjs.remove(dir, { recursive: true });
}
