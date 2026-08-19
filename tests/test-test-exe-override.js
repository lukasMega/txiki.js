import assert from 'tjs:assert';

// Guards the premise of the whole per-profile verification story: when the test
// runner is pointed at another binary with TJS_TEST_EXE, this test file must be
// executing *in that binary*. If run-tests.js ever stopped honouring the
// override, every profile run would silently re-test the host instead of the
// shipped artifact, and would still be green.

const override = tjs.env.TJS_TEST_EXE;

if (override) {
    assert.eq(await tjs.realPath(tjs.exePath), await tjs.realPath(override),
        'tests run in the binary named by TJS_TEST_EXE');
} else {
    // Without the override the runner must spawn itself, so exePath is simply
    // this binary -- assert it is a usable path rather than nothing at all.
    assert.ok((await tjs.stat(tjs.exePath)).isFile, 'tjs.exePath points at the running binary');
}
