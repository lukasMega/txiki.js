// Startup with module init. The delta against noop.js isolates the bytecode-inflate plus
// module-instantiation cost, which is exactly what BUILD_WITH_COMPRESSED_BYTECODE trades
// binary size for -- so this pair is the metric that makes that trade visible.
//
// These three must exist in EVERY published profile; none of them is feature-gated in
// cmake/slim.cmake. Do not add tjs:sqlite / tjs:ffi / tjs:wasi here -- they vanish on the
// slim profiles and would make this workload measure a different thing per binary.

import assert from 'tjs:assert';
import { createHash } from 'tjs:hashing';
import path from 'tjs:path';

// A sentinel, checked by bench.mjs. A failed static import of a `tjs:` module currently
// aborts with exit status 0 and no output, so "the process exited 0" does NOT prove the
// imports resolved -- see .claude/plans/2026-08-19_upstream-pr-silent-module-load.md.
// Without this line a broken workload would be timed as a very fast startup.
console.log(typeof path.join === 'function' && typeof assert.ok === 'function' && typeof createHash === 'function'
    ? 'READY'
    : 'BROKEN');
