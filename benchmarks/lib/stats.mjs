// Robust summary statistics. Median + MAD throughout, per METHODOLOGY.md rule 4:
// a single descheduled sample on a shared runner moves a mean far more than a median.

export function median(xs) {
    if (xs.length === 0) {
        return null;
    }

    const s = [ ...xs ].sort((a, b) => a - b);
    const mid = s.length >> 1;

    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Median absolute deviation. Reported raw (not scaled by 1.4826 to a normal-consistent
// sigma) because the distribution of process spawn times is not normal -- it is a hard
// floor with a right tail -- so a "sigma" would invite exactly the wrong reading.
export function mad(xs) {
    const m = median(xs);

    return m === null ? null : median(xs.map(x => Math.abs(x - m)));
}

export function stddev(xs) {
    if (xs.length < 2) {
        return null;
    }

    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + ((b - mean) ** 2), 0) / (xs.length - 1);

    return Math.sqrt(variance);
}

export function min(xs) {
    return xs.length ? Math.min(...xs) : null;
}

// A run is "unstable" when its MAD exceeds 5% of its median (METHODOLOGY.md rule 4).
// The report marks these rather than dropping them.
export function summarize(xs) {
    const m = median(xs);
    const d = mad(xs);

    return {
        median: m,
        mad: d,
        stddev: stddev(xs),
        min: min(xs),
        runs: xs.length,
        unstable: m !== null && d !== null && m > 0 ? (d / m) > 0.05 : null
    };
}

export function round(x, digits = 3) {
    if (x === null || x === undefined || !Number.isFinite(x)) {
        return null;
    }

    const f = 10 ** digits;

    return Math.round(x * f) / f;
}
