---
sidebar_position: 5
title: Fork and CI internals
---

import ForkNotice from '@site/src/components/ForkNotice';

# Fork and CI internals

<ForkNotice />

This page is for contributors. [Downloads](./downloads.md) is for users of the binaries.

The fork's one rule: keep fork changes outside upstream-owned files. That keeps upstream merges
cheap and makes failures visible.

| upstream file | fork delta | fork-owned location |
| --- | --- | --- |
| `CMakeLists.txt` | one include plus eight call sites | `cmake/slim.cmake` |
| `Makefile` | one include | `slim.mk` |
| `docusaurus.config.ts` | none | `website/docusaurus.fork.config.ts` |
| `ci.yml` | one paths-ignore block | `required.yml`, `verify.yml`, `dist.yml` |

`master` mirrors upstream; `slim` is the fork trunk. Scheduled jobs never push to `slim` — they
open pull requests for a human to merge.

## Daily automation

| UTC | workflow | purpose |
| --- | --- | --- |
| 04:30 | `sync-upstream.yml` | fast-forward upstream mirror |
| 05:47 | `merge-check.yml` | dry-run merge and track conflicts |
| 06:15 | `auto-merge-pr.yml` | open merge proposal when clean |
| 07:00 | `upstream-release.yml` | publish slim release after upstream release |

## Required checks

`required.yml` always reports the required `lint` and `codegen` contexts, and `verify.yml`
always builds the six profiles. Neither is path-filtered. Upstream's `ci.yml` stays advisory
because a filtered workflow reports *no check at all*, which leaves a required context
permanently pending and the pull request unmergeable.

<details>
<summary>Merge safety and workflow-file changes</summary>

`cmake/slim.cmake` declares the options and directory flags; target configuration runs at eight
specific call sites. One configurator is a macro rather than a function, because the WAMR
variables it sets must land in the caller's scope.

Run `scripts/setup-repo.sh` once per clone. It registers the `keep-ours` merge driver for the
generated QuickJS bundles and the CA blob. Git ignores merge drivers defined in tracked config,
so without the local registration a text merge can produce invalid generated files *without
reporting a conflict*. Regenerate bundles only after every `src/js/**` conflict is resolved; the
generated output belongs in the merge commit.

The bots stand down when a merge touches `.github/workflows/**`, because `GITHUB_TOKEN` cannot
push workflow files. Merge those locally:

```bash
mise run sync:upstream
mise run sync:regen
```

Lifting that restriction means a PAT or GitHub App token with workflow scope — a deliberate
decision to keep a long-lived push credential in the repository, not a config tweak.

</details>

<details>
<summary>Release matrix and dependencies</summary>

`scripts/build-dist.mjs` is a dependency-free Node driver for macOS, Linux and Windows. It
reimplements the Make bundle pipeline because GNU make's POSIX-shell recipes cannot run on a
Windows runner; the two must stay byte-identical in their output.

`dist.yml` is fronted by a `gate` job that emits both the profile and the platform matrix. Tags,
manual dispatches and release-labelled pull requests build eight profiles on four platforms.
An ordinary build-affecting pull request builds four profiles on macOS and Windows only, since
`verify.yml` already covers the Linux feature profiles. The gate re-implements upstream's path
filter itself, because GitHub ANDs `paths` with event `types`.

Vendored patches are applied to the submodule work trees at CMake configure time by
`tjs_apply_patches`. Forward and reverse checks make re-configuring idempotent; a state that is
neither is a hard error, never a silent skip. Each patch is upstreamed, then deleted once the
submodule is bumped past its merge.

</details>

<details>
<summary>Formatting and job summaries</summary>

CI pins clang-format 18 (the `ubuntu-24.04` distro package). Use `mise run format`, which
refuses to run under any other major version — a newer local formatter produces a red Lint that
cannot be reproduced locally.

For every slim job, read the SKIP count as well as the FAIL count. Green output can still mean
too many tests were skipped. [Testing a slim build](./testing-slim-builds.md) explains feature
gating.

</details>

## Updating size and speed data after a release

Release builds publish `slim-sizes-v1.json` beside the ZIP files and checksums, containing
exact unpacked binary sizes, ZIP sizes, feature vectors and digests for the full 8 × 4 matrix.
Import one explicit tag; never a moving “latest” release:

```bash
node scripts/release-size-manifest.mjs import --release slim-v26.6.0-9
node website/scripts/generate-slim-metrics.mjs
node website/scripts/generate-slim-metrics.mjs --check
```

The first import of a tag creates `website/data/slim-metrics/releases/<tag>.json`. A second
identical import is a no-op; changed remote bytes are rejected rather than overwriting history.
`slim-v26.6.0-8` predates the manifest, so its one-time import reads `BUILDINFO.txt` from each
published ZIP. New releases must use the manifest path.

Speed results are separate. Dispatch `bench.yml` on the exact release tag with `profiles=all`,
download both JSON artifacts, and add them under `benchmarks/history/<platform>/`. Nothing
pushes those files to `slim`; review their runner, toolchain, sampling parameters and
dirty/quick flags, then regenerate both reports:

```bash
node benchmarks/report.mjs
node website/scripts/generate-slim-metrics.mjs
```

Run both `--check` commands before committing. The Docusaurus build never calls GitHub and uses
only committed JSON.

### Re-measuring what each feature costs

The third input is on its own schedule. It is a controlled study, not a per-release step: rerun it
when a dependency bump or a new removable switch is expected to have moved the answer, not because
a release happened.

```bash
mise run metrics:study     # ~19 clean serial builds; budget an evening
mise run metrics:check     # the three --check commands ci-docs.yml runs
```

`scripts/feature-study-v1.json` holds the switch table: for each removable capability, the CMake
options, the esbuild defines, and the runtime probe that proves the switch landed. The driver
builds a maximal baseline — every feature on, every CLI define `true` — and turns exactly one
thing off per pair, because every published profile already ships most of the CLI defines off and
pairing against one of those would measure nothing.

<details>
<summary>What the driver refuses to do</summary>

It refuses to start on a dirty tree, restores `src/bundles/c` around every define-changing build,
and fails if a binary came out smaller while still reporting the feature it was supposed to lose.
The record's date is the commit's date rather than wall-clock, so rerunning at the same commit and
toolchain reproduces the file byte for byte. Windows is not supported: the study drives `make`.

</details>
