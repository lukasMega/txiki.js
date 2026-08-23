import { report } from './prng.js';

// The libuv hot path. This one MUST be flat across profiles -- no slim lever touches libuv
// -- so a move here is the strongest available signal that a size flag (LTO, -Oz, ICF,
// --gc-sections) has cost real runtime performance. That is its whole reason for existing.
//
// 1M at once is the plan's figure but ~200MB of resident timer handles on a 4-core runner;
// scheduled in waves instead, which measures the same uv_timer path without making
// workloadPeakRssBytes a measurement of this file rather than of the runtime.

const TOTAL = 1000000;
const WAVE = 50000;

{
    const t0 = performance.now();
    let fired = 0;

    for (let wave = 0; wave < TOTAL / WAVE; wave++) {
        await new Promise(resolve => {
            let left = WAVE;

            for (let i = 0; i < WAVE; i++) {
                setTimeout(() => {
                    fired++;

                    if (--left === 0) {
                        resolve();
                    }
                }, 0);
            }
        });
    }

    const ms = performance.now() - t0;

    if (fired !== TOTAL) {
        throw new Error(`timer loss: fired ${fired} of ${TOTAL}`);
    }

    report('timers', TOTAL, ms);
}

{
    // Microtask drain: the JS-side job queue, no libuv involvement. Pairs with the timer
    // row to separate "the event loop got slower" from "promise resolution got slower".
    const N = 500000;
    const t0 = performance.now();
    let acc = 0;

    for (let i = 0; i < N; i++) {
        acc = await Promise.resolve(acc + 1);
    }

    globalThis.__benchSink = acc;
    report('microtasks', N, performance.now() - t0);
}
