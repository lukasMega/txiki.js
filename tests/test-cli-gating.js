import assert from 'tjs:assert';
import path from 'tjs:path';

// Black-box check that the CLI surface matches what the binary advertises in
// tjs.engine.features. Slim builds compile subcommands out with esbuild
// --define, and nothing else verifies that the gating is honest in both
// directions: a subcommand reported as present must be reachable, and one
// reported as absent must not be.
//
// Self-adapting on purpose -- it asserts against this binary's own feature
// vector, so it is meaningful on a full build and on every slim profile
// without a feature-skip.json entry. Under TJS_TEST_EXE, tjs.exePath is the
// artifact under test, so this exercises the shipped binary.

const features = tjs.engine.features;

// The fall-through message an unknown/compiled-out subcommand produces.
const genericUsage = `Usage: ${path.basename(tjs.exePath)} [options] [subcommand]`;

async function runCli(args) {
    const proc = tjs.spawn([ tjs.exePath, ...args ], { stdout: 'pipe', stderr: 'pipe' });
    const [ status, stdout, stderr ] = await Promise.all([
        proc.wait(),
        proc.stdout.text(),
        proc.stderr.text()
    ]);

    return { status, stdout, stderr };
}

// Invoked with no arguments, an enabled subcommand prints its own usage and
// exits non-zero; a compiled-out one falls through to the generic usage. That
// difference is what tells the two apart -- both exit non-zero.
const subcommands = [
    { flag: 'cliEval', args: [ 'eval' ], usage: 'eval EXPRESSION' },
    { flag: 'cliServe', args: [ 'serve' ], usage: 'serve [options] FILE' },
    { flag: 'cliBundler', args: [ 'bundle' ], usage: 'bundle [options] infile' },
    { flag: 'cliApp', args: [ 'app' ], usage: 'app <subcommand>' },
];

for (const { flag, args, usage } of subcommands) {
    const { status, stderr } = await runCli(args);

    assert.notEqual(status.exit_status, 0, `${args[0]} with no arguments exits non-zero`);

    if (features[flag]) {
        assert.ok(stderr.includes(usage), `${flag} is true, so "${usage}" is reachable: ${stderr}`);
    } else {
        assert.ok(stderr.startsWith(genericUsage), `${flag} is false, so ${args[0]} is not a subcommand: ${stderr}`);
        assert.ok(!stderr.includes(usage), `${flag} is false, so its usage is compiled out: ${stderr}`);
    }
}

// `eval` is the one subcommand that can be driven to a positive result without
// a side effect, so prove it actually evaluates rather than merely parsing.
if (features.cliEval) {
    const { status, stdout } = await runCli([ 'eval', 'console.log(41 + 1)' ]);

    assert.eq(status.exit_status, 0, 'eval succeeds');
    assert.eq(stdout.trim(), '42', 'eval evaluates the expression');
}

// -h is an option rather than a subcommand, so it fails differently: getopts
// rejects it outright when __TJS_HELP__ is false.
{
    const { status, stdout, stderr } = await runCli([ '-h' ]);

    if (features.cliHelp) {
        assert.eq(status.exit_status, 0, '-h succeeds');
        assert.ok(stdout.startsWith(genericUsage), '-h prints the usage banner');
        assert.ok(stdout.includes('Subcommands:'), '-h prints the full help');
    } else {
        assert.notEqual(status.exit_status, 0, '-h exits non-zero');
        assert.ok(stderr.includes('unrecognized option: h'), '-h is not a known option');
    }
}

// `run` is kept in every profile -- the whole host-driven test loop depends on
// it, so a regression here would be silent and total.
{
    const { status, stderr } = await runCli([ 'run' ]);

    assert.notEqual(status.exit_status, 0, 'run with no file exits non-zero');
    assert.ok(stderr.includes('run [options] FILE'), 'run is present in every build');
}
