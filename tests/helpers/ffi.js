import FFI from 'tjs:ffi';

// The fixture library lives in the CMake binary dir, which is ./build for a
// plain `make`. TJS_TEST_LIBDIR points the suite at a different one -- CI
// builds the driver and the fixtures in their own tree so that running the
// suite never reconfigures a developer's ./build.
const libDir = tjs.env.TJS_TEST_LIBDIR || './build';
const sopath = `${libDir}/libffi-test.${FFI.suffix}`;

export { FFI, sopath };
