---
sidebar_position: 3
title: Size and speed
---

import ForkNotice from '@site/src/components/ForkNotice';

# Size and speed

<ForkNotice />

Every number on this page carries the platform, the date and the commit it was measured at.
That is not politeness — the same build on a different toolchain can move by 3%, and a bare
percentage with no provenance is worse than no table at all.

Two independent things make a slim binary small, and they are worth keeping apart:

1. **Removing features** — `BUILD_WITH_WASM=OFF`, `BUILD_WITH_TLS=OFF`, and friends. Large,
   predictable, and it changes what the runtime can do.
2. **Changing how the same code is compiled** — `-Oz`, LTO, dead-code stripping, identical
   code folding. Smaller, and it changes only how fast the runtime is.

The published profiles combine both. [Downloads](./downloads.md) lists what you can get
prebuilt; [Slim builds](./slim-builds.md) documents every option.

## What each feature costs

Measured on **linux-x86_64, GCC 13.3, `slim-v26.6.0-8` (commit `1274e5e7`, 2026-08-24)**,
from the `BUILDINFO.txt` inside each published artifact. Unpacked binary, stripped.

| profile | binary | vs `min` |
| --- | ---: | ---: |
| `min` | 1,914,824 B | — |
| `ffi` | 1,964,424 B | +48 KB |
| `tls` | 2,365,536 B | +440 KB |
| `sqlite` | 2,717,208 B | +784 KB |
| `ffi-tls` | 2,406,944 B | +481 KB |
| `ffi-tls-sqlite` | 3,209,344 B | +1,264 KB |

For reference, a **default upstream build of the same commit is 8,900,848 B**. The `min`
profile is `0.22×` of it. Most of that gap is WebAssembly: WAMR is compiled out of every
published profile.

TLS is mbedTLS plus the embedded Mozilla CA bundle; SQLite is the amalgamation. Neither is
compressible much further — if you need them, you need the bytes.

## What the codegen modes cost

`tuned-min` and `balanced-min` are the `min` feature set at a different optimisation
setting. They exist because **`-Oz` is not free**: it costs real interpreter throughput.

Measured on **macOS arm64, Apple clang**, `min` feature set, using the QuickJS workload from
the size study; minimum user-CPU time of 7 runs:

| variant | binary | Δ size | time | Δ time |
| --- | ---: | ---: | ---: | ---: |
| `smallest` — `-Oz` + LTO | 1,976,112 B | — | 1.29 s | — |
| `tuned` — outliner off | 2,057,888 B | +4.1% | 0.94 s | −27% |
| **`balanced` — QuickJS at `-Os`** | **2,107,728 B** | **+6.7%** | **0.75 s** | **−41%** |
| both together | 2,140,416 B | +8.3% | 0.75 s | −41% |
| previous `balanced` — whole binary `-Os`, no LTO | 2,189,136 B | +10.8% | 0.76 s | −41% |

Measured 2026-08-24 for [PR #32](https://github.com/lukasMega/txiki.js-with-slim-builds/pull/32).

Three conclusions, in order of how easy they are to get wrong:

### The machine outliner is the expensive part of `-Oz`

Clang enables its machine outliner by default at `-Oz`. It finds repeated instruction
sequences and turns them into calls — which is exactly the wrong trade inside QuickJS's
interpreter dispatch loop. On arm64 it bought **4% of the binary for 30% of the run time**.

`BUILD_WITH_NO_OUTLINE=ON` turns it off. Note it is *two* flags, not one: under LTO,
codegen happens at link, so the compile-time `-mno-outline` is a silent no-op on its own and
the option adds a linker-side `-mllvm -enable-machine-outliner=never` as well.

### Raising just the engine beats turning the outliner off

`BUILD_WITH_QJS_SPEED=ON` compiles `deps/quickjs` at `-Os` while everything else stays at
`-Oz`. That works because the binary is not uniform: essentially all JS execution time is in
the engine, while libuv, libwebsockets, mbedTLS and ada are cold once the runtime is up.

It survives LTO, where `-mno-outline` does not — `-Os` and `-Oz` are recorded per function
in the IR as the `optsize` and `minsize` attributes, which the LTO backend reads at link.

### The two do not stack

The machine outliner only runs on `minsize` functions. `-Os` does not set that attribute, so
raising the engine to `-Os` already puts it out of the outliner's reach. Enabling both cost
**+32,688 B for no change in run time**, which is why `--optimization balanced` explicitly
sets `BUILD_WITH_NO_OUTLINE=OFF`.

### Where the modes are no-ops

`-Oz` is a Clang feature, so on **Linux (GCC)** and **Windows (MSVC)** it never applies —
the build is already at `-Os`, and `tuned-min` is byte-identical to `min` there. Verified
against `slim-v26.6.0-8`'s `SHA256SUMS.txt`: same SHA-256 for both Linux architectures.
`balanced-min` still differs everywhere, since the engine's optimisation level is not a
Clang-only lever.

**macOS arm64 is the only platform where all three modes genuinely differ.**

:::warning Numbers ahead of the artifacts

The `balanced` row above is the *current* recipe. `slim-v26.6.0-8` was cut before it landed
and still ships the previous one (whole binary at `-Os`, LTO off) — on linux-x86_64 that is
1,947,800 B against `min`'s 1,914,824 B. The next release will carry the newer, smaller
build at the same speed.

:::

## Continuous benchmarks

Sizes alone do not tell you whether a slim build is slower at anything that matters, so the
fork records a benchmark run per release: startup, resident memory, and a set of throughput
workloads, on `linux-x86_64` and `macos-arm64`. It compares the full build against `min`,
`ffi`, `tls` and `ffi-tls` — the SQLite profiles are not benchmarked, since SQLite adds
bytes rather than changing how the engine runs.

The generated report lives in
[`benchmarks/README.md`](https://github.com/lukasMega/txiki.js-with-slim-builds/blob/slim/benchmarks/README.md)
and is regenerated by `node benchmarks/report.mjs`. Prefer it over this page for anything
current: it is machine-written from recorded runs and states its runner, toolchain and
sampling parameters for every figure.

From the run at `slim-v26.6.0-8-4-g709c52a` (2026-08-24), the shape of the result on
`linux-x86_64`, as ratios of the full build:

| metric | `min` |
| --- | ---: |
| binary size, raw | 0.22× |
| binary size, gzip -9 | 0.25× |
| baseline RSS | 0.40× |
| peak RSS, event loop | 0.57× |
| `JSON.parse` throughput | **0.63×** |
| SHA-256 throughput | 1.07× |

Read the ratios, not the absolute numbers — hosted runners drift with image and hardware.

The `JSON.parse` row is the honest cost of `-Oz` — it is engine work, in the code path the
outliner damages — and it is the reason `tuned-min` and `balanced-min` are published at all.
SHA-256, which is native code the engine barely touches, comes out at or slightly above
`1.00×`; treat that as "unaffected", not as a speedup.

:::note

There is deliberately **no regression gate** on these numbers yet — the benchmark job is
report-only. A gate needs several releases of history first, to know what normal run-to-run
noise looks like on hosted runners. A metric whose tool is unavailable is recorded as
missing, never as zero.

:::

## Measuring your own build

`bench.mjs` takes the binaries to compare explicitly, so nothing is measured by accident:

```bash
node benchmarks/bench.mjs \
  --binary full=build/tjs \
  --binary min=dist/min/tjs \
  --binary balanced-min=dist/balanced-min/tjs

node benchmarks/report.mjs          # regenerate benchmarks/README.md from recorded runs
node benchmarks/report.mjs --check  # verify it is current, without writing
```

Add `--quick` for a smoke run (5 spawns, 1 rep). It is explicitly **not a valid
measurement** — use it to check the harness works, never to compare builds.

The methodology — what is sampled, how many spawns and warmups, and what the results do not
prove — is in
[`benchmarks/METHODOLOGY.md`](https://github.com/lukasMega/txiki.js-with-slim-builds/blob/slim/benchmarks/METHODOLOGY.md).
