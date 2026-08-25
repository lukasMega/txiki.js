# Benchmark methodology

Hand-written source for the methodology section of the generated `README.md`.
`report.mjs` (phase P3) copies this file verbatim; edit it here, never in `README.md`.

## Rules

1. **One machine, one job, serial.** All binaries are measured back-to-back in a single job on
   a single machine. Timing and RSS numbers from different jobs are never compared to each
   other. Only the `vs full` ratio is comparable across runs.
2. **Runner pinned.** CI legs pin `ubuntu-24.04` and `macos-15`, never `*-latest`, so image
   drift shows up as a version change rather than as noise.
3. **Warmup then measure.** 10 warmup spawns then 50 measured spawns for startup; best-of-5
   reps for in-process throughput. Minimum is the most stable estimator for compute-bound work,
   so `ops/sec` uses the best rep, not the mean.
4. **Report median + MAD**, never mean + stddev. Anything whose MAD exceeds 5% of its median is
   flagged as unstable *for that run* rather than silently averaged in.
5. **Normalise to `full`.** Every table carries a `vs full` ratio column. Cross-release trends
   use that ratio, because absolute numbers on hosted runners drift with image and hardware.
6. **Report-only.** There is no regression gate, exactly like the size gate in `dist.yml` before
   budgets existed. A gate on the size and startup ratios can follow once several releases of
   history exist.
7. **Missing is not zero.** A metric whose tool is unavailable (no `size(1)`) or whose feature is
   compiled out of the binary under test records `null` and renders as `—`. It never becomes 0
   and never enters an average.

## Honest limits

- Hosted runners are shared CPUs with noisy neighbours. Expect **5–15% run-to-run variance** on
  wall-clock metrics. **A ±10% wall-clock move is not a regression.**
- "Cold startup" means a fresh *process*, not a cold page cache. The binary is already resident
  after the warmup spawns, so these numbers are a floor, not a first-run-on-a-cold-disk figure.
- No CPU pinning, no `nice`, no isolated cpuset. `cpuEfficiency` = `(user+sys)/wall` is reported
  precisely so threaded work (mimalloc background threads, GC) is visible rather than hidden
  inside a flat wall clock.
- Peak RSS comes from `/usr/bin/time`, because txiki.js has no in-process `uv_getrusage`
  binding. If that tool is absent the driver fails loudly rather than reporting 0.
- Binary size is the one metric here that is exact and machine-independent. Trust it the most.

## What is measured

| id | how built |
| --- | --- |
| `full` | `make` — Release, all features, full CLI. The recipe `release.yml` ships as the official asset |
| `balanced-min` | `node scripts/build-dist.mjs --profile min --optimization balanced` |
| `tuned-min` | `node scripts/build-dist.mjs --profile min --optimization tuned` |
| `min` | `node scripts/build-dist.mjs --profile min` — no FFI, no TLS |
| `ffi` | `--profile ffi` |
| `tls` | `--profile tls` |
| `sqlite` | `--profile sqlite` |
| `ffi-tls` | `--profile ffi-tls` |
| `ffi-tls-sqlite` | `--profile ffi-tls-sqlite` |

All binaries come from the **same commit**, so the feature/flag delta is the only variable.

> `scripts/build-dist.mjs` rewrites `src/bundles/`. It restores them on every exit path, but the
> driver must still build `full` **first** and assert `git diff --quiet src/bundles/c` between
> builds — a dirty bundle tree silently changes what the next binary contains.
