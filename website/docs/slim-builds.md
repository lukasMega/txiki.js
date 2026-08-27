---
sidebar_position: 1
title: Slim builds
---

import ForkNotice from '@site/src/components/ForkNotice';

# Slim builds

<ForkNotice />

Slim builds make two separate trades:

1. Remove runtime features. This reduces size and API surface.
2. Change compilation and linking. This reduces size without removing features.

Every figure below comes from the paired study charted on
[Size and speed](./size-and-speed.md#what-each-feature-costs), which keeps the platform, commit,
toolchain and both binary digests behind each number. Browse it there for the CLI and polyfill
switches this table does not list.

Use a published profile when it fits. Otherwise, start with `min` and add only required
features. [Downloads](./downloads.md) explains profiles; [Size and speed](./size-and-speed.md)
shows measured results.

## Build quickly

```bash
cmake -B build-slim -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_WITH_WASM=OFF -DBUILD_WITH_SQLITE=OFF -DBUILD_WITH_TLS=OFF
cmake --build build-slim
```

## Feature switches

| CMake option | Default | Result | Measured saving |
| --- | --- | --- | ---: |
| `BUILD_WITH_TLS=OFF` | ON | Removes HTTPS, WSS and TLS sockets | 469,863 B † |
| `BUILD_WITH_MIMALLOC=OFF` *(upstream)* | ON | Uses system allocator | 153,239 B ‡ |
| `BUILD_WITH_BUNDLED_CA=OFF` | ON | Removes embedded Mozilla CA bundle | 108,952 B |
| `BUILD_WITH_WASM_FULL=OFF` | ON | Keeps WAMR classic interpreter; removes SIMD | 69,973 B |
| `BUILD_WITH_FFI=OFF` *(upstream)* | ON | Removes libffi and `tjs:ffi` | 68,907 B |
| `BUILD_WITH_WEBCRYPTO=OFF` | ON | Removes `crypto.subtle` | 55,144 B § |
| `BUILD_WITH_REPL=OFF` | ON | Removes interactive REPL | 14,140 B |

`BUILD_WITH_WASM=OFF` and `BUILD_WITH_SQLITE=OFF` are upstream switches used by published
profiles. Feature state is available through `tjs.engine.features`; CLI state is available
through `tjs.engine.cli`.

<details>
<summary>How these were measured, and why they cannot be added up</summary>

Measured 2026-08-25 on macOS arm64 (Apple clang 21, CMake 4.4), commit `05707539`, one Release
build per switch against a baseline with every feature on. **These are linked code and data
bytes, not file size.** The two differ by more than you would expect: Mach-O pads segments to a
16 KB page, so the REPL's 14,140 bytes move the executable file by 608 bytes and the test-runner
subcommand's 5,952 bytes move it by *minus* 128. If what you care about is the download, read the
released-profile sizes on [Size and speed](./size-and-speed.md) instead.

- † TLS cannot be removed alone. It drags the bundled CA and the `--tls-ca` option out with it,
  so this single number contains all three. Removing only the CA bundle is the 108,952 B row.
- ‡ mimalloc is an allocator swap, not a capability you lose — but it is the one entry here with
  a throughput cost, which this size-only study does not measure.
- § Measured with **TLS on**, where `libmbedcrypto` stays linked for TLS regardless. On a
  no-TLS build the same flag is worth far more, because WebCrypto is then the only thing keeping
  mbedcrypto alive: a MinSizeRel + `-Oz` + LTO + ICF + strip + hardening pair measured 2,240,304 B
  against 2,057,744 B on 2026-08-25, a **182,560 B** saving. Both numbers are correct for their
  recipe. This is exactly why the chart shows bars and not a Sankey.

Absolute numbers also move with the codegen mode. This study builds plain `Release`; a published
profile is MinSizeRel + `-Oz` + LTO + `--gc-sections` + strip, where dead-code elimination has
already removed some of what a feature would otherwise contribute. Read the bars as a ranking and
an order of magnitude, not as a subtraction you can perform on a shipped artifact.

</details>

## Size-only switches

| CMake option | Result |
| --- | --- |
| `BUILD_WITH_OZ=ON` | Uses Clang `-Oz` for `MinSizeRel` |
| `BUILD_WITH_NO_OUTLINE=ON` | Disables Clang AArch64 machine outliner |
| `BUILD_WITH_QJS_SPEED=ON` | Compiles QuickJS at `-Os`; rest remains `-Oz` |
| `BUILD_WITH_HIDDEN_VISIBILITY=ON` | Lets linker and LTO prune non-exported symbols |
| `BUILD_WITH_ICF=ON` | Folds identical code where linker supports it |
| `BUILD_WITH_COMPRESSED_BYTECODE=ON` | Deflates embedded JS bytecode |
| `BUILD_WITH_REPRODUCIBLE_PATHS=ON` | Removes absolute source paths |
| `BUILD_WITH_HARDENING=ON` | Enables supported exploit mitigations |

For macOS arm64, prefer `balanced` when speed matters: it costs 6.7% more bytes than
smallest mode and cuts measured QuickJS time by 41%. `tuned` is smaller, but slower than
`balanced`. Linux GCC and Windows MSVC already use `-Os`, so these modes usually collapse to
`min`.

<details>
<summary>Feature caveats</summary>

`BUILD_WITH_TLS=OFF` keeps plain HTTP, WS, TCP and UDP. HTTPS, WSS, `TLSSocket` and
`TLSServerSocket` report that TLS is unavailable. Web Crypto remains available because it
links `libmbedcrypto` independently.

`BUILD_WITH_BUNDLED_CA=OFF` affects TLS builds only. Supply a bundle with `TJS_CA_BUNDLE` or
`tjs.setCABundlePath()`; otherwise certificate verification fails. This build does not fall
back to operating-system trust stores because txiki.js uses libwebsockets with mbedTLS.

`BUILD_WITH_WEBCRYPTO=OFF` removes `crypto.subtle`. It breaks WinterTC compliance plus
`tjs app pack` and `tjs app compile`; `crypto.getRandomValues()` and `crypto.randomUUID()`
remain available. Its 178.3 KiB figure came from paired macOS arm64 builds on 2026-08-25:
2,240,304 B versus 2,057,744 B.

Removing REPL needs CMake and JS gates together:

```bash
make js RUN_MAIN_DEFINES="--define:__TJS_REPL__=false --define:__TJS_EVAL__=true \
  --define:__TJS_SERVE__=true --define:__TJS_BUNDLER__=true --define:__TJS_TEST_RUNNER__=true \
  --define:__TJS_COMPILE__=true --define:__TJS_APP__=true --define:__TJS_HELP__=true \
  --define:__TJS_TLS_CA__=true"
BUILD_WITH_REPL=OFF make
```

Using only CMake leaves JS calling a missing binding. Using only JS keeps unreachable bytecode.
No-argument invocation then reports no REPL; stdin programs and other entry points still work.

`BUILD_WITH_WASM_FULL=OFF` keeps WebAssembly, but removes SIMD and uses slower WAMR classic
interpreter. It matters only when `BUILD_WITH_WASM=ON`. Do not disable WAMR multi-module:
that breaks `WebAssembly.Memory.prototype.grow()` and `WebAssembly.Table.prototype.grow()`.

</details>

<details>
<summary>Codegen details and distribution recipes</summary>

`BUILD_WITH_OZ` needs Clang and only changes `MinSizeRel`; GCC warns and stays at `-Os`.
`BUILD_WITH_ICF` uses `--icf=safe` with lld or gold, Apple dead-strip where available, and
MSVC `/OPT:ICF`. MSVC skips visibility, reproducible-path, hardening and unwind-table flags.

Compressed bytecode requires matching bundle generation:

```bash
BUILD_WITH_COMPRESSED_BYTECODE=ON make js TJSC_COMPRESS=-z
```

`BUILD_WITH_QJS_SPEED` matters only with `BUILD_WITH_OZ`. It supersedes
`BUILD_WITH_NO_OUTLINE`: `-Os` QuickJS functions are already outside machine outliner scope.

Build distribution variants with:

```bash
node scripts/build-dist.mjs --profile min --optimization tuned \
  --build-dir build-dist-tuned-min --out dist/tuned-min
node scripts/build-dist.mjs --profile min --optimization balanced \
  --build-dir build-dist-balanced-min --out dist/balanced-min
```

`tuned` disables machine outliner at compile and link time; LTO needs both settings.
`balanced` raises only QuickJS to `-Os`, retaining LTO everywhere else. It improves run time
without paying whole-binary `-Os` cost.

`BUILD_WITH_NO_UNWIND_TABLES=ON` removes async unwind tables. C++ exceptions still unwind,
but crash and signal backtraces become unusable. Published non-MSVC binaries enable it; build
from source with it off when backtraces matter.

</details>
