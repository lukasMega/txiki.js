// Spawning and resource measurement.
//
// There is no in-process RSS API in txiki.js today (no uv_getrusage binding), so peak RSS
// has to come from /usr/bin/time. Its two dialects are incompatible in both flag and output
// format, and BSD `time` on macOS does not understand `-v` at all, so the dialect is probed
// once rather than inferred from process.platform (Homebrew coreutils `gtime` on a Mac is
// the GNU dialect).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const TIME_CANDIDATES = [ '/usr/bin/time', '/usr/local/bin/gtime', '/opt/homebrew/bin/gtime' ];

let cachedTime;

// Returns { path, dialect: 'gnu' | 'bsd' }. Throws -- METHODOLOGY.md's "missing is not zero"
// applies to per-metric gaps, but a driver that cannot measure memory at all should say so
// up front instead of emitting a result file full of nulls.
export function detectTime() {
    if (cachedTime !== undefined) {
        return cachedTime;
    }

    for (const path of TIME_CANDIDATES) {
        if (!existsSync(path)) {
            continue;
        }

        // GNU time understands -v; BSD time treats it as the command to run and fails.
        const gnu = spawnSync(path, [ '-v', 'true' ], { encoding: 'utf8' });

        if (gnu.status === 0 && /Maximum resident set size/i.test(gnu.stderr ?? '')) {
            cachedTime = { path, dialect: 'gnu' };

            return cachedTime;
        }

        const bsd = spawnSync(path, [ '-l', 'true' ], { encoding: 'utf8' });

        if (bsd.status === 0 && /maximum resident set size/i.test(bsd.stderr ?? '')) {
            cachedTime = { path, dialect: 'bsd' };

            return cachedTime;
        }
    }

    throw new Error(
        `no usable /usr/bin/time found (tried ${TIME_CANDIDATES.join(', ')}). ` +
        'Install GNU time (apt install time / brew install gnu-time). ' +
        'Refusing to report 0 for peak RSS.'
    );
}

// GNU time reports maxrss in KiB on every platform. BSD time reports it in BYTES on macOS
// (and KiB on the BSDs) -- getting this backwards is a silent 1024x error in the report,
// which is why the two branches are split rather than sharing a multiplier.
export function parseTimeOutput(stderr, dialect) {
    const num = re => {
        const m = stderr.match(re);

        return m ? Number(m[1]) : null;
    };

    if (dialect === 'gnu') {
        const kib = num(/Maximum resident set size \(kbytes\):\s*([0-9.]+)/i);
        const user = num(/User time \(seconds\):\s*([0-9.]+)/i);
        const sys = num(/System time \(seconds\):\s*([0-9.]+)/i);
        const wallRaw = stderr.match(/Elapsed \(wall clock\) time [^:]*:\s*([0-9:.]+)/i);

        return {
            maxRssBytes: kib === null ? null : kib * 1024,
            userS: user,
            sysS: sys,
            wallS: wallRaw ? parseGnuElapsed(wallRaw[1]) : null
        };
    }

    // BSD: "<real> real <user> user <sys> sys" then an indented "<n>  maximum resident set size".
    const line = stderr.match(/([0-9.]+)\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys/i);

    return {
        maxRssBytes: num(/([0-9]+)\s+maximum resident set size/i),
        userS: line ? Number(line[2]) : null,
        sysS: line ? Number(line[3]) : null,
        wallS: line ? Number(line[1]) : null
    };
}

// GNU prints either "m:ss.SS" or "h:mm:ss".
function parseGnuElapsed(s) {
    const parts = s.split(':').map(Number);

    return parts.reduce((acc, p) => (acc * 60) + p, 0);
}

// Wall-clock a single spawn with hrtime. Deliberately NOT measured through /usr/bin/time:
// wrapping adds its own fork+exec to every sample, which is a large fraction of a ~10ms
// startup measurement. Resource use is collected separately by runWithTime().
export function timeSpawn(exe, args, opts = {}) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(exe, args, { encoding: 'utf8', ...opts });
    const t1 = process.hrtime.bigint();

    return {
        ms: Number(t1 - t0) / 1e6,
        status: r.status,
        signal: r.signal,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        error: r.error
    };
}

export function runWithTime(exe, args, opts = {}) {
    const { path, dialect } = detectTime();
    const flag = dialect === 'gnu' ? '-v' : '-l';
    const r = spawnSync(path, [ flag, exe, ...args ], { encoding: 'utf8', ...opts });

    if (r.error) {
        throw r.error;
    }

    return {
        status: r.status,
        signal: r.signal,
        stdout: r.stdout ?? '',
        // The time report is interleaved with the child's own stderr; the parsers key on
        // labels, so the child's noise is ignored rather than needing to be separated.
        stderr: r.stderr ?? '',
        resources: parseTimeOutput(r.stderr ?? '', dialect)
    };
}

// Workloads print `BENCH <name> <ops> <ms>` and nothing else. Anything else on stdout is a
// bug in the workload, not something to tolerate quietly.
export function parseBenchLines(stdout) {
    const out = [];

    for (const raw of stdout.split('\n')) {
        const line = raw.trim();

        if (line === '') {
            continue;
        }

        const m = line.match(/^BENCH\s+(\S+)\s+([0-9.]+)\s+([0-9.]+)$/);

        if (!m) {
            throw new Error(`unexpected workload output line: ${JSON.stringify(line)}`);
        }

        out.push({ name: m[1], ops: Number(m[2]), ms: Number(m[3]) });
    }

    return out;
}

export function checkedRun(exe, args, what) {
    const r = timeSpawn(exe, args);

    if (r.error) {
        throw new Error(`${what}: ${r.error.message}`);
    }

    if (r.status !== 0) {
        throw new Error(`${what}: exited ${r.status}${r.signal ? ` (${r.signal})` : ''}\n${r.stderr}`);
    }

    return r;
}

export function gitCapture(args, cwd) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}
