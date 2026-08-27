---
sidebar_position: 4
title: Testing a slim build
---

import ForkNotice from '@site/src/components/ForkNotice';

# Testing a slim build

<ForkNotice />

Published profiles have `tjs test` compiled out, but CI runs every shipped binary through the
full suite before release. To test a custom or downloaded profile yourself, use a full-CLI
binary as the driver and the slim binary as the test executable:

```bash
TJS_TEST_EXE=$(pwd)/dist/min/tjs ./build/tjs test tests/
```

Every test file runs inside `TJS_TEST_EXE`; the driver only finds files, spawns processes and
reports results. With mise:

```bash
mise run test:dist min
mise run test:dist:all
```

**Read SKIP count.** A profile can pass while skipping too much.

<details>
<summary>Feature-aware skipping</summary>

`tests/feature-skip.json` maps unavailable features to test patterns. Plain keys come from
`tjs.engine.features`; `cli.` keys come from `tjs.engine.cli`. Only a single `*` wildcard is
supported — no `**`, no `?`.

Before the loop, the runner probes `TJS_TEST_EXE` for its own feature vector, not the host
driver's, so tests are gated on the binary under test. A probe that fails, prints nothing or
reports fewer keys than the host is a hard error, never a silent pass.

Three tests assert against the binary's own feature vector and therefore run on every profile:
`test-cli-gating.js` (a subcommand is reachable iff `tjs.engine.cli` says so),
`test-builtin-module-gating.js` (a `tjs:` module imports iff its feature is on) and
`test-test-exe-override.js` (the suite really is running inside `TJS_TEST_EXE`).

</details>

<details>
<summary>Native fixtures and CI coverage</summary>

Some tests `dlopen` a fixture library built next to `tjs`. Point the driver at them, or those
tests fail loudly rather than skipping:

```bash
TJS_TEST_EXE=$(pwd)/dist/min/tjs \
TJS_TEST_LIBDIR=$(pwd)/build-host \
  ./build-host/tjs test tests/
```

`scripts/build-dist.mjs --host-tjs` builds the driver and those fixtures into `--host-dir`
(default `build-host`). Never point `--host-dir` at your normal `./build`: it configures a
feature-reduced tree, and the cached options would silently survive into your next ordinary
build.

`verify.yml` tests the six feature profiles on Linux for every push and pull request;
`dist.yml` tests all eight across four platforms before anything is published.
`build-dist.mjs` also asserts the expected feature vector at build time, so a flipped CMake
default fails there rather than as a confusing test failure.

</details>

See [Fork and CI internals](./fork-and-ci.md) for workflow details.
