import assert from 'tjs:assert';

// The REPL is gated by BUILD_WITH_REPL (C: run-repl.c + core.runRepl) paired
// with --define:__TJS_REPL__ (JS: the dispatch branch). This asserts the vector
// the binary publishes, and that the one path REPL gating could plausibly break
// -- reading a program from a pipe -- still works either way.
//
// It cannot do more than that from here. The REPL is reached only when stdin is
// a terminal, and the suite has no pty to hand it; `tjs:internal/core` is not
// exposed to user code, so `core.runRepl`'s presence is not observable from JS
// either. What guards the C half is that a BUILD_WITH_REPL=OFF binary linking
// at all proves run-repl.c and its native binding were dropped together.

const cli = tjs.engine.cli;

assert.eq(typeof cli.repl, 'boolean', 'tjs.engine.cli.repl is published');

// stdin is not a terminal under the test runner, so this is the evalStdin
// branch -- the one the REPL check sits in front of.
const proc = tjs.spawn([ tjs.exePath ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });

const writer = proc.stdin.getWriter();

await writer.write(new TextEncoder().encode('console.log(41 + 1);\n'));
await writer.close();

const [ status, stdout ] = await Promise.all([ proc.wait(), proc.stdout.text() ]);

assert.eq(status.exit_status, 0, 'a piped program runs on every build');
assert.eq(stdout.trim(), '42', 'a piped program is evaluated, not handed to the REPL');
