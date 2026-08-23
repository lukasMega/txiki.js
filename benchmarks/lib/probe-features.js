/* global tjs */

// Run by lib/env.mjs via `tjs run` to read the feature vector of the binary under test.
//
// Deliberately `run` and not `eval`: `eval` is one of the subcommands the slim profiles
// compile out (`tjs.engine.cli.eval`), so `tjs eval` would fail on exactly the binaries
// this suite exists to measure. `run` is kept in every published profile. Same reasoning,
// and same shape, as the suite's own probe in src/js/run-main/skip.js.

console.log(JSON.stringify({ features: tjs.engine.features, cli: tjs.engine.cli ?? null }));
