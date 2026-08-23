// mulberry32, seeded. Shared by every workload so that all binaries under comparison do
// byte-identical work: an unseeded Math.random() would give each binary a different input
// distribution and quietly turn a size comparison into a luck comparison.

export function mulberry32(seed) {
    let a = seed >>> 0;

    return function () {
        a = (a + 0x6D2B79F5) >>> 0;

        let t = a;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const SEED = 0x5EED1234;

// Best-of-N is applied by the driver across whole process runs; within a run each workload
// just reports one honest (ops, ms) pair. `report` is the only thing a workload may print.
export function report(name, ops, ms) {
    console.log(`BENCH ${name} ${ops} ${ms.toFixed(3)}`);
}

export function timed(name, ops, fn) {
    const t0 = performance.now();
    const sink = fn();
    const t1 = performance.now();

    // Consume the result so a sufficiently clever optimiser cannot delete the work.
    // globalThis assignment is cheap and unobservable to the measurement.
    globalThis.__benchSink = sink;

    report(name, ops, t1 - t0);
}
