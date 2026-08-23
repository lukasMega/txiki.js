import { SEED, mulberry32, report } from './prng.js';

// JSON.parse / JSON.stringify are C fast paths in QuickJS, so this exercises engine C code
// rather than the interpreter -- a useful counterweight to compute.js.

const rand = mulberry32(SEED);
const doc = { records: [] };

for (let i = 0; i < 5000; i++) {
    doc.records.push({
        id: i,
        name: `record-${i}`,
        score: rand(),
        tags: [ 'alpha', 'beta', 'gamma' ].slice(0, 1 + ((i % 3) | 0)),
        nested: { active: (i % 2) === 0, ratio: rand(), note: null }
    });
}

const text = JSON.stringify(doc);
const bytes = new TextEncoder().encode(text).length;
const REPS = 20;

{
    const t0 = performance.now();
    let sink = 0;

    for (let i = 0; i < REPS; i++) {
        sink += JSON.parse(text).records.length;
    }

    const ms = performance.now() - t0;

    globalThis.__benchSink = sink;
    report('json-parse', REPS, ms);
    // Reported as its own row rather than folded into ops/s: MB/s is the number that stays
    // meaningful if the fixture document is ever resized.
    report('json-parse-mbps', (bytes * REPS) / (1024 * 1024), ms);
}

{
    const t0 = performance.now();
    let sink = 0;

    for (let i = 0; i < REPS; i++) {
        sink += JSON.stringify(doc).length;
    }

    const ms = performance.now() - t0;

    globalThis.__benchSink = sink;
    report('json-stringify', REPS, ms);
}
