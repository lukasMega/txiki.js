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

This fork publishes size-optimized binaries alongside the normal build. Every profile is
`MinSizeRel`/`-Oz` + LTO + dead-strip + ICF + hidden visibility + stripped symbols, with
compressed bytecode, no mimalloc, no WebAssembly and no SQLite. They differ only in whether
FFI and TLS are compiled in.

Sizes are the **uncompressed `tjs` binary** from release
[`slim-v26.6.0-6`](https://github.com/lukasMega/txiki.js-with-slim-builds/releases/tag/slim-v26.6.0-6),
measured from the published artifacts, in MiB:

| profile | FFI | TLS | linux-x86_64 | linux-arm64 | macos-arm64 | windows-x86_64 |
| --- | :-: | :-: | ---: | ---: | ---: | ---: |
| `min` | — | — | **1.83** | 2.08 | 1.92 | 2.30 |
| `ffi` | ✓ | — | 1.87 | 2.15 | 1.96 | 2.37 |
| `tls` | — | ✓ | 2.25 | 2.58 | 2.37 | 2.78 |
| `ffi-tls` | ✓ | ✓ | 2.29 | 2.58 | 2.42 | 2.84 |
| upstream `v26.6.0` | ✓ | ✓ | *(no asset)* | *(no asset)* | 5.64 | 5.33 |

Against upstream's own assets — the only directly comparable pair, since upstream publishes no
Linux binary — `min` is **34%** of the full macOS build (**43%** on Windows), and `ffi-tls`,
which keeps both optional subsystems, is **43%** (**53%** on Windows).

Two caveats the numbers do not show:

* **Windows is a different profile, not the same one on another OS.** Six of the size and
  hardening levers are MSVC no-ops, so the Windows artifacts are deliberately built and named as
  a separate, non-hardened profile. The Linux/macOS artifacts additionally carry
  `BUILD_WITH_HARDENING` (stack protector, zeroed locals, arm64 PAC/BTI — roughly +245 KB), which
  is why they are not simply the smallest thing that could be shipped.
* **Every profile compiles out `tjs test`** (and other subcommands), so the binaries cannot run
  the test suite on themselves. CI runs the whole suite *against* each shipped artifact using a
  full-CLI driver — see `TJS_TEST_EXE` in `CLAUDE.md`.

All four profiles are built for all four platforms, and each one runs the full test suite before
it is published. Feature vectors are recorded per artifact in its `BUILDINFO.txt`.

<br />

<footer>
<p align="center" style="font-size: smaller;">
Built with ❤️ by saghul and these awesome <a href="https://github.com/saghul/txiki.js/graphs/contributors" target="_blank">contributors</a>.
</footer>

[QuickJS-ng]: https://github.com/quickjs-ng/quickjs
[libuv]: https://libuv.org/
[WinterTC]: https://wintertc.org/
