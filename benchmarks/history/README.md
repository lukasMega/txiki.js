# Result history

`bench.mjs` writes one JSON per run to `<platform>/<version>.json`, e.g.
`linux-x86_64/slim-v26.6.0-7.json`. `report.mjs` (phase P3, not yet written) reads every file
here plus the newest run and regenerates `../README.md`.

Nothing is committed here yet. Per phase **P5**, history is committed back **only from tag
runs** in `bench.yml`, never from a PR run and never from a local run — a local result is
measured on unknown hardware against a possibly dirty tree, and the whole point of the store is
that a trend line across releases is comparable.

Every result records `commit`, `dirty`, `platform`, `runner` and `toolchain`, so a datapoint
that later looks wrong can be explained rather than argued about. `dirty: true` marks a result
that is not reproducible from `commit` alone; those must never be committed here.

To produce one locally without touching this directory, pass `--out`:

```sh
node benchmarks/bench.mjs --binary full=./build/tjs --out /tmp/bench.json
```
