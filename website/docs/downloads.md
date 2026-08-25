---
sidebar_position: 2
title: Downloads
---

import ForkNotice from '@site/src/components/ForkNotice';

# Download a released binary

<ForkNotice />

Each slim release ships **eight profiles on four platforms**, from
[Releases](https://github.com/lukasMega/txiki.js-with-slim-builds/releases), under tags such as
`slim-v26.6.0-8`.

## Pick a profile first

Start with `min` and add only the capabilities your program needs.

| profile | FFI | TLS | SQLite | Best fit |
| --- | :---: | :---: | :---: | --- |
| `min` | — | — | — | scripting and embedding |
| `ffi` | ✅ | — | — | `tjs:ffi` |
| `tls` | — | ✅ | — | HTTPS, WSS and TLS sockets |
| `sqlite` | — | — | ✅ | `tjs:sqlite` and persistent `localStorage` |
| `ffi-tls` | ✅ | ✅ | — | networked native-library use |
| `ffi-tls-sqlite` | ✅ | ✅ | ✅ | all published optional features |
| `tuned-min` | — | — | — | `min`, different size/speed codegen |
| `balanced-min` | — | — | — | `min`, faster QuickJS codegen |

`tuned-min` and `balanced-min` add no API. See [Size and speed](./size-and-speed.md) for
their measured trade.

Every profile keeps Web Crypto, REPL and `tjs compile`. Every profile removes WebAssembly,
`tjs:wasi`, plus `tjs eval`, `serve`, `bundle`, `test`, `app` and `help`.

## Install

```bash
VERSION=slim-v26.6.0-8
ASSET=txiki-slim-min-linux-x86_64.zip

curl -fsSLO "https://github.com/lukasMega/txiki.js-with-slim-builds/releases/download/$VERSION/$ASSET"
unzip "$ASSET"
cd "${ASSET%.zip}"
chmod +x tjs
echo 'console.log(tjs.version)' | ./tjs
```

Assets are named `txiki-slim-{profile}-{platform}.zip`, where the platform is `linux-x86_64`,
`linux-arm64`, `macos-arm64` or `windows-x86_64`. Each archive unpacks into its own directory
containing the executable, `BUILDINFO.txt` and `SHA256SUMS`.

Inspect any binary through stdin:

```bash
echo 'console.log(tjs.engine.features, tjs.engine.cli)' | ./tjs
```

<details>
<summary>Windows installation and checksum verification</summary>

```powershell
$Version = 'slim-v26.6.0-8'
$Asset   = 'txiki-slim-min-windows-x86_64.zip'

Invoke-WebRequest -Uri "https://github.com/lukasMega/txiki.js-with-slim-builds/releases/download/$Version/$Asset" -OutFile $Asset
Expand-Archive $Asset -DestinationPath .
Set-Location ($Asset -replace '\.zip$','')
'console.log(tjs.version)' | .\tjs.exe
```

A single release-level `SHA256SUMS.txt` verifies every unpacked executable. Run it from the
archives' parent directory, not from inside a profile directory:

```bash
cd ..
curl -fsSLO "https://github.com/lukasMega/txiki.js-with-slim-builds/releases/download/$VERSION/SHA256SUMS.txt"
sha256sum --check --ignore-missing SHA256SUMS.txt
```

`--ignore-missing` verifies the profile you downloaded without requiring the other 31 artifacts.
`BUILDINFO.txt` records the profile, codegen mode, feature vector, platform, size in bytes,
SHA-256 and MSVC status.

</details>

<details>
<summary>Platform caveats and recorded archive sizes</summary>

On MSVC nine of the eleven size and hardening levers are compiled out, so Windows binaries are
roughly 10–27% larger than their Unix counterparts and are shipped as a deliberately
non-hardened profile. Linux GCC has no `-Oz` either, so `min`, `tuned-min` and the current
`balanced-min` recipes collapse onto the same binary on both Linux and Windows — macOS arm64 is
the only platform where the codegen choice changes anything. `slim-v26.6.0-8` was built with
the previous `balanced` recipe, so its `balanced-min` row does not represent the next release.

Compressed archive sizes from `slim-v26.6.0-8` (2026-08-24):

| profile | linux-x86_64 | linux-arm64 | macos-arm64 | windows-x86_64 |
| --- | ---: | ---: | ---: | ---: |
| `min` | 1.03 MB | 1.10 MB | 1.07 MB | 1.31 MB |
| `tuned-min` | 1.03 MB | 1.10 MB | 1.05 MB | 1.31 MB |
| `balanced-min` | 1.03 MB | 1.12 MB | 1.11 MB | 1.32 MB |
| `ffi` | 1.06 MB | 1.13 MB | 1.10 MB | 1.35 MB |
| `tls` | 1.31 MB | 1.40 MB | 1.36 MB | 1.62 MB |
| `sqlite` | 1.49 MB | 1.62 MB | 1.57 MB | 1.79 MB |
| `ffi-tls` | 1.34 MB | 1.43 MB | 1.39 MB | 1.66 MB |
| `ffi-tls-sqlite` | 1.80 MB | 1.95 MB | 1.90 MB | 2.14 MB |

These are ZIP sizes; the unpacked executable is roughly twice as large. Build from source when
none of the eight fits — for example TLS without the embedded CA bundle, or WebAssembly.

</details>
