<p align="center">
    <img width="240" src="https://raw.githubusercontent.com/saghul/txiki.js/master/website/static/img/logo-heartonly.png" />
</p>

# txiki.js — The tiny JavaScript runtime

> **txikia** (Basque): small, tiny.

*txiki.js* is a small and powerful JavaScript runtime. It targets state-of-the-art ECMAScript
and aims to be [WinterTC] compliant.

It's built on the shoulders of giants: it uses [QuickJS-ng] as its JavaScript engine and [libuv] as the platform layer.

## Quick start

```bash
# Get the code
git clone --recursive https://github.com/saghul/txiki.js --shallow-submodules && cd txiki.js
# Compile it!
make
# Run the REPL
./build/tjs
```

See [Building](https://txikijs.org/docs/building) for detailed instructions including Windows support.

## Features

- Web Platform APIs: `fetch`, `WebSocket`, `Console`, `setTimeout`, `Crypto`, Web Workers, and more
- TCP, UDP, and Unix sockets
- HTTP server with WebSocket support
- File I/O, child processes, signal handling
- Standard library: `tjs:sqlite`, `tjs:ffi`, `tjs:path`, `tjs:hashing`, and more
- Standalone executables via `tjs compile`

## Documentation

Full documentation is available at **[txikijs.org](https://txikijs.org)**.

## Supported platforms

* GNU/Linux
* macOS
* Windows
* Other Unixes (please test!)

---

## Slim builds (this fork)

This fork publishes size-optimized binaries alongside the normal build. Six smallest profiles use
`MinSizeRel`/`-Oz` + LTO. Two `min`-feature variants trade size back for speed, both still
`-Oz` + LTO overall: `tuned-min` turns off Clang's AArch64 machine outliner, and `balanced-min`
raises `deps/quickjs` — where essentially all JS execution time goes — back to `-Os`, leaving the
cold two thirds of the binary at `-Oz`. Every profile also uses dead-strip + ICF + hidden visibility +
stripped symbols, with compressed bytecode, no mimalloc and no WebAssembly. Feature profiles
differ in whether FFI, TLS and SQLite are compiled in.

Sizes are the **uncompressed `tjs` binary** from release
[`slim-v26.6.0-8`](https://github.com/lukasMega/txiki.js-with-slim-builds/releases/tag/slim-v26.6.0-8),
measured from the published artifacts, in MiB:

| profile | FFI | TLS | SQLite | linux-x86_64 | linux-arm64 | macos-arm64 | windows-x86_64 |
| --- | :-: | :-: | :-: | ---: | ---: | ---: | ---: |
| `balanced-min` | — | — | — | 1.86 | 2.15 | 2.09 | 2.32 |
| `tuned-min` | — | — | — | 1.83\* | 2.08\* | 1.96 | 2.31\* |
| `min` | — | — | — | **1.83** | 2.08 | 1.92 | 2.31 |
| `ffi` | ✓ | — | — | 1.87 | 2.15 | 1.96 | 2.37 |
| `tls` | — | ✓ | — | 2.26 | 2.58 | 2.39 | 2.79 |
| `sqlite` | — | — | ✓ | 2.59 | 3.04 | 2.80 | 3.10 |
| `ffi-tls` | ✓ | ✓ | — | 2.30 | 2.58 | 2.42 | 2.85 |
| `ffi-tls-sqlite` | ✓ | ✓ | ✓ | 3.06 | 3.54 | 3.33 | 3.64 |
| upstream `v26.6.0` | ✓ | ✓ | ✓ | *(no asset)* | *(no asset)* | 5.64 | 5.33 |

\* **Byte-identical to `min`.** `-Oz` and the machine outliner are Clang-only, and the Linux
artifacts are built with GCC while Windows uses MSVC, so `tuned-min` — which is `min` with the
outliner disabled — has nothing to disable on three of the four platforms. macOS is the only place
the codegen profiles are distinct binaries.

> The `balanced-min` row is the last release built with the old `-Os`, no-LTO recipe. It now
> raises only `deps/quickjs` to `-Os` instead, measured ~80 KB smaller at the same speed on macOS,
> and — like `tuned-min` — asking for nothing GCC or MSVC can do, so that row moves at the next
> release and is expected to join the starred group on three of the four platforms.

On macOS arm64, against `min`, a fib/property/sort/string/Map workload runs **27% faster** on
`tuned-min` for **+4.1%** size and **41% faster** on `balanced-min` for **+6.7%**. If you care
about execution speed more than the last 100 KB, those are the two to reach for; if you care about
size, `min` is still the floor everywhere.

SQLite is the single most expensive optional feature here — up to **+0.95 MiB** over `min`, more
than TLS and the bundled CA together — which is why it is off in the other four profiles. Only
the two SQLite profiles have a persistent `localStorage`; on the others it falls back to an
in-memory store.

Against upstream's own assets — the only directly comparable pair, since upstream publishes no
Linux binary — `min` is **34%** of the full macOS build (**43%** on Windows). `ffi-tls-sqlite`,
which is the closest match to what upstream ships, is **59%** (**68%** on Windows); `ffi-tls`,
without SQLite, is **43%** (**53%**).

Two caveats the numbers do not show:

* **Windows is a different profile, not the same one on another OS.** Six of the size and
  hardening levers are MSVC no-ops, so the Windows artifacts are deliberately built and named as
  a separate, non-hardened profile. The Linux/macOS artifacts additionally carry
  `BUILD_WITH_HARDENING` (stack protector, zeroed locals, arm64 PAC/BTI — roughly +245 KB), which
  is why they are not simply the smallest thing that could be shipped.
* **Every profile compiles out `tjs test`** (and other subcommands), so the binaries cannot run
  the test suite on themselves. CI runs the whole suite *against* each shipped artifact using a
  full-CLI driver — see `TJS_TEST_EXE` in `CLAUDE.md`.

All eight profiles are built for all four platforms, and each one runs the full test suite before
it is published. Feature vectors are recorded per artifact in its `BUILDINFO.txt`.

<br />

<footer>
<p align="center" style="font-size: smaller;">
Built with ❤️ by saghul and these awesome <a href="https://github.com/saghul/txiki.js/graphs/contributors" target="_blank">contributors</a>.
</footer>

[QuickJS-ng]: https://github.com/quickjs-ng/quickjs
[libuv]: https://libuv.org/
[WinterTC]: https://wintertc.org/
