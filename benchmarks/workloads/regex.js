import { SEED, mulberry32, timed } from './prng.js';

// QuickJS uses libregexp, a separate engine from the interpreter. Kept distinct from
// compute.js so a libregexp change is attributable.

const rand = mulberry32(SEED);
const WORDS = [ 'alpha', 'beta', 'gamma', 'delta', 'epsilon', '2026-08-20', 'user@example.com', '192.168.0.1' ];
const lines = [];

for (let i = 0; i < 20000; i++) {
    const n = 4 + Math.floor(rand() * 5);
    const parts = [];

    for (let j = 0; j < n; j++) {
        parts.push(WORDS[Math.floor(rand() * WORDS.length)]);
    }

    lines.push(parts.join(' '));
}

const corpus = lines.join('\n');

timed('regex-match', lines.length, () => {
    // Not /g on a shared literal: a global regex carries lastIndex across calls, which
    // would make the amount of work depend on iteration order.
    const re = /(\d{4})-(\d{2})-(\d{2})/;
    let hits = 0;

    for (const line of lines) {
        if (re.test(line)) {
            hits++;
        }
    }

    return hits;
});

timed('regex-replace', 1, () => corpus.replace(/[a-z]+@[a-z.]+/g, '<email>').length);

timed('regex-split', 1, () => corpus.split(/\s+/).length);
