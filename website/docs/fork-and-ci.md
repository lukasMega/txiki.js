---
sidebar_position: 5
title: Fork and CI internals
---

import ForkNotice from '@site/src/components/ForkNotice';

# Fork and CI internals

<ForkNotice />

Contributor-facing. Nothing here is needed to *use* a slim build — see
[Downloads](./downloads.md) for that.

This fork tracks [upstream txiki.js](https://github.com/saghul/txiki.js) continuously rather
than snapshotting it. That constraint shapes every decision below: the goal is that an
upstream commit lands here with as close to zero manual work as possible, and that the
places where it *can't* fail silently.

## The organising principle: keep the delta out of upstream's files

Upstream edits `CMakeLists.txt`, the `Makefile` and `ci.yml` constantly. A fork that edits
them too pays a merge conflict every week, forever. So every fork-only addition lives in a
**new file**, and the delta inside an upstream-owned file is reduced to a single line that
pulls it in:

| upstream file | fork delta | fork-owned file |
| --- | --- | --- |
| `CMakeLists.txt` | one `include()` + eight call sites | `cmake/slim.cmake` |
| `Makefile` | one `-include` | `slim.mk` |
| `docusaurus.config.ts` | **none** — passed `--config` instead | `website/docusaurus.fork.config.ts` |
| `ci.yml` | one `paths-ignore` block | `required.yml`, `verify.yml`, `dist.yml` |

The same idea applies to docs: `CLAUDE.md` keeps upstream's sections byte-identical and puts
every fork addition in one block at the end.

CMake is imperative, so that split is not merely cosmetic. The option declarations and
directory-scoped compile flags have to run at the `include()`, while each
`tjs_slim_configure_*` function runs at the one point where its target already exists. One
of the eight is a **macro rather than a function** for the same reason: it overrides plain
directory-scope `WAMR_*` variables, and a function body would set them in its own scope,
where WAMR would never see them.

## The daily sync chain

Four scheduled workflows, in order. Each recomputes what it needs rather than passing state
along — workflow outputs do not survive across runs, and a stale answer is worse than a
spare dry-run merge.

| cron (UTC) | workflow | does |
| --- | --- | --- |
| 04:30 | `sync-upstream.yml` | fast-forwards the fork's `master` mirror from upstream |
| 05:47 | `merge-check.yml` | dry-runs the merge into `slim`; owns a single reused tracking issue |
| 06:15 | `auto-merge-pr.yml` | opens `chore/upstream-merge-<date>` when the dry run is clean |
| 07:00 | `upstream-release.yml` | publishes `slim-vX.Y.Z-N` once upstream releases `vX.Y.Z` |

**Nothing in the chain ever pushes to `slim`.** Every merge is offered as a pull request that
a human clicks. `upstream-release` stands down while an `auto-merge-pr` proposal is still
open, and vice versa.

Note the fork's `master` branch is *the upstream mirror*, not the fork's trunk. The fork's
trunk is `slim`. That is why upstream's own `deploy-docs.yml` — which builds `master` —
publishes none of these pages, and is disabled here in favour of a fork-owned workflow.

### Workflow files can't be pushed by a bot

Both branch-pushing steps stand down when the merge touches `.github/workflows/**`, and say
so with a notice. This is not a bug to retry around: `workflows` is **not one of the
permissions a `GITHUB_TOKEN` can be granted** — there is no such key — so the push is
rejected outright, and rejected *after* the merge and the bundle regeneration have already
run.

Upstream's Dependabot bumps its workflow actions regularly, so this fires often. Merge those
locally:

```bash
mise run sync:upstream   # setup-repo, tag a rollback point, merge, then regenerate bundles
mise run sync:regen      # re-run just the regeneration after fixing a conflict by hand
```

Lifting the restriction means putting a long-lived PAT or GitHub App token with workflow
scope in the repo. That is a deliberate security decision, not a config tweak.

### Run `scripts/setup-repo.sh` once per clone

It registers the `keep-ours` merge driver that `.gitattributes` names for
`src/bundles/c/**` and `src/cacert.c`. **Git deliberately ignores merge drivers defined in
tracked config** — a driver is arbitrary code — so a fresh clone has no idea what
`merge=keep-ours` means and falls back to a normal text merge.

That fallback is the one failure mode here that is silent. Those files are QuickJS bytecode
byte-arrays and a compressed CA blob; a three-way *text* merge of either produces output
valid for neither side, and git cannot tell. Nothing is lost by keeping ours: the bundles
are pure functions of `src/js/**`, which merges normally, and are regenerated afterwards.

Order matters and is easy to get wrong: the regeneration reads `src/js/**`, so it must run
**after** the last conflict there is resolved, and its output belongs in the merge commit.
CI catches a skipped regeneration — but only after you have pushed.

## Which checks gate what

GitHub reports **no check at all** for a workflow that path filtering skipped. A *required*
context that never reports leaves a pull request permanently "Expected" and unmergeable.
That single rule explains the whole check layout:

| workflow | path-filtered? | provides |
| --- | --- | --- |
| `required.yml` | **never** | `lint`, `codegen` — the required contexts |
| `verify.yml` | **never** | the six profile builds — required |
| `ci.yml` (upstream's) | yes | `Lint`, `Codegen` and 34 others — all advisory |

`required.yml` duplicates upstream's lint and codegen steps rather than reusing them,
precisely because `ci.yml` is filtered and cannot host a required context. Both jobs take
about two minutes, which is what makes paying for them twice acceptable. **Nothing detects
drift between the two copies** — if upstream changes how it lints, `required.yml` must be
updated by hand.

Running six profile builds on a typo fix is the cheaper mistake than a permanently
unmergeable docs PR.

:::note

A **skipped** required check counts as a pass in branch protection. That is worth
remembering wherever a label or a filter can cause a check not to run.

:::

## Release builds

`scripts/build-dist.mjs` is a dependency-free Node driver that produces the distributed
binaries on all three platforms. It reimplements the JS bundle pipeline in Node rather than
calling `make`, because the `Makefile` is GNU make with POSIX shell recipes and cannot run
on a Windows runner. `make` and `mise` remain the local development path.

Its output is byte-identical to the equivalent `make` invocation, and keeping it that way is
a requirement when changing either side.

`dist.yml` runs it as a matrix fronted by a `gate` job, which emits **both matrix axes** as
JSON. That is what lets a pull request run 8 jobs where a release tag runs 32:

- a tag, a manual dispatch or a release-labelled PR gets **8 profiles × 4 platforms**;
- an ordinary build-affecting PR gets **4 profiles × macOS and Windows only** — the floor,
  the ceiling, and both codegen modes.

The Linux half is dropped from PRs because `verify.yml` already builds and tests all six
feature profiles on Linux for every push. What it cannot cover is Apple clang — the only
toolchain that actually gets `-Oz` and the machine outliner — and MSVC.

`gate` also re-implements `ci.yml`'s path filter by hand against the PR's file list, because
GitHub **ANDs** `paths` with `types`: a `labeled` event on a PR touching none of those paths
would otherwise never start the workflow at all.

## Updating size and speed data after a release

Release builds now publish `slim-sizes-v1.json` beside the ZIP files and checksums. It contains
exact unpacked binary sizes, ZIP sizes, feature vectors and digests for the full 8 × 4 matrix.
Import one explicit tag; never use a moving “latest” release:

```bash
node scripts/release-size-manifest.mjs import --release slim-v26.6.0-9
node website/scripts/generate-slim-metrics.mjs
node website/scripts/generate-slim-metrics.mjs --check
```

The first import of a tag creates
`website/data/slim-metrics/releases/<tag>.json`. A second identical import is a no-op; changed
remote bytes are rejected instead of overwriting history. `slim-v26.6.0-8` predates the manifest,
so its one-time import reads `BUILDINFO.txt` from each published ZIP. New releases must use the
manifest path.

Speed results remain separate. Dispatch `bench.yml` on the exact release tag with `profiles=all`,
download both JSON artifacts, and add them under `benchmarks/history/<platform>/`. Nothing pushes
those files to `slim`; review their runner, toolchain, sampling parameters and dirty/quick flags,
then regenerate both reports:

```bash
node benchmarks/report.mjs
node website/scripts/generate-slim-metrics.mjs
```

Before committing, require both `--check` commands. The Docusaurus build never calls GitHub and
uses only committed JSON.

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

It refuses to start on a dirty tree, restores `src/bundles/c` around every define-changing build,
and fails if a binary came out smaller while still reporting the feature it was supposed to lose.
The record's date is the commit's date rather than wall-clock, so rerunning at the same commit and
toolchain reproduces the file byte for byte. Windows is not supported: the study drives `make`.

## Vendored dependencies are patched at configure time

`tjs_apply_patches(<submodule> <prefix>)` globs `patches/<prefix>*.patch` and applies each to
the submodule work tree when CMake configures. It is idempotent — it forward-checks, then
reverse-checks — and a state that is **neither** is a fatal error rather than a silent skip.

Two patches today: QUIC support that upstream mbedTLS lacks, and a use-after-scope on
libwebsockets' HTTP/3-to-TCP fallback path. `.gitmodules` sets `ignore = dirty` on both, so
`git status` stays quiet; do not commit or revert those edits.

Each patch is upstreamed. Delete the file once the submodule is bumped past its merge.

## clang-format 18 is the arbiter

CI installs the `ubuntu-24.04` distro package — **clang-format 18** — and fails on a dirty
tree. A newer local formatter reformats files that 18 then wants back, and the resulting red
Lint **cannot be reproduced locally**: re-running the newer formatter is a no-op.

Use `mise run format`, not `make format`. It refuses to run unless the major version is 18.

## Reading a job summary

For any of the build workflows, **read the SKIP count, not just the FAIL count.** A profile
can go green by skipping too much — see
[Testing a slim build](./testing-slim-builds.md) for how the skip filter decides.
