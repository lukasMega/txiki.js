import { report } from './prng.js';

// GATED on the `webcrypto` feature. BUILD_WITH_WEBCRYPTO=OFF drops crypto.subtle while
// keeping getRandomValues/randomUUID, so the two halves below are gated separately: on a
// LITE profile the digest rows are null and the getRandomValues rows still measure.
//
// The driver reads tjs.engine.features and records `null` + skipped:["crypto"] rather than
// running this at all when webcrypto is off; the guard here is the second line of defence,
// so that running the file by hand fails loudly instead of throwing a bare TypeError.

const SIZE = 256 * 1024;
const REPS = 40;
const buf = new Uint8Array(SIZE);

for (let i = 0; i < SIZE; i++) {
    buf[i] = i & 0xFF;
}

if (typeof crypto?.subtle?.digest !== 'function') {
    throw new Error('crypto.subtle is unavailable: this workload requires the webcrypto feature');
}

{
    const t0 = performance.now();
    let sink = 0;

    for (let i = 0; i < REPS; i++) {
        sink += (await crypto.subtle.digest('SHA-256', buf)).byteLength;
    }

    const ms = performance.now() - t0;

    globalThis.__benchSink = sink;
    report('sha256', REPS, ms);
    report('sha256-mbps', (SIZE * REPS) / (1024 * 1024), ms);
}

{
    const small = new Uint8Array(4096);
    const t0 = performance.now();

    for (let i = 0; i < 2000; i++) {
        crypto.getRandomValues(small);
    }

    report('getrandomvalues', 2000, performance.now() - t0);
}
