// Markdown tables and number formatting for report.mjs.
//
// Every formatter here is locale-free by construction: `toLocaleString()` would make the
// generated README depend on the machine's LANG, and `report.mjs --check` compares bytes.
// Thousands are grouped with a plain ASCII space, matching the tables in the plan.

// METHODOLOGY.md rule 7: a metric that was not measured -- tool absent, feature compiled
// out, field unknown to this generator -- renders as this and never as 0.
export const MISSING = '—';

export function table(headers, aligns, rows) {
    const sep = aligns.map(a => (a === 'r' ? '---:' : '---'));
    const lines = [ row(headers), row(sep) ];

    for (const r of rows) {
        lines.push(row(r));
    }

    return `${lines.join('\n')}\n`;
}

function row(cells) {
    return `| ${cells.join(' | ')} |`;
}

// Cells are generated, not user text, but a `|` in a binary id or a cc version string would
// still silently split a column.
export function cell(s) {
    return String(s).replace(/\|/g, '\\|');
}

export function groupInt(n) {
    const neg = n < 0;
    const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

    return neg ? `-${s}` : s;
}

function finite(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

export function fmtBytes(x) {
    return finite(x) ? groupInt(x) : MISSING;
}

// Binary units throughout, matching bench.mjs's own progress output ("5950 KiB raw").
export function fmtMiB(x) {
    return finite(x) ? (x / (1024 * 1024)).toFixed(2) : MISSING;
}

export function fmtMs(x) {
    return finite(x) ? x.toFixed(2) : MISSING;
}

// Below 1000 a single decimal is what the numbers actually carry (json-stringify is ~67
// docs/s); above it the fraction is noise, so group and drop it.
export function fmtOps(x) {
    if (!finite(x)) {
        return MISSING;
    }

    return x >= 1000 ? groupInt(x) : x.toFixed(1);
}

export function fmtNum(x, digits = 2) {
    return finite(x) ? x.toFixed(digits) : MISSING;
}

// `dir` is which way is *better*: 'lower' for size/time/RSS, 'higher' for ops/sec. A ratio
// more than 5% worse than `full` is bolded -- 5% is METHODOLOGY.md rule 4's own instability
// threshold, so anything under it is inside the noise the report already admits to.
export function fmtRatio(value, base, dir) {
    if (!finite(value) || !finite(base) || base === 0) {
        return MISSING;
    }

    const r = value / base;
    const text = `${r.toFixed(2)}×`;
    const worse = dir === 'higher' ? r < 0.95 : r > 1.05;

    return worse ? `**${text}**` : text;
}
