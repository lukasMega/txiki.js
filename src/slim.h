/*
 * txiki.js -- fork-only slim-build shims (lukasMega/txiki.js-with-slim-builds).
 *
 * Included at the bottom of private.h, once TJSRuntime is complete.
 *
 * When a subsystem is compiled out, its `tjs__*_init` is not linked in and
 * private.h does not declare it. Rather than wrapping each call site in
 * `#ifdef`, this header supplies an empty stub, so `src/vm.c` -- a file
 * upstream edits often, in exactly the spot where the guards would sit
 * (tjs__bootstrap_core) -- stays byte-identical to upstream.
 *
 * Only bodyless entry points belong here. Guards that depend on a struct
 * member or on a `static` function local to a .c file (e.g. TJS_NO_TLS_CA
 * around tjs__set_ca_bundle_path in vm.c) cannot be expressed this way and
 * stay as `#ifdef`s at the site.
 */

#ifndef TJS_SLIM_H
#define TJS_SLIM_H

#ifndef TJS_HAVE_TLS
static inline void tjs__mod_tls_init(JSContext *ctx, JSValue ns) {
    (void) ctx;
    (void) ns;
}

static inline void tjs__mod_tls_cleanup(TJSRuntime *qrt) {
    (void) qrt;
}
#endif

#ifndef TJS_HAVE_WEBCRYPTO
static inline void tjs__webcrypto_init(JSContext *ctx, JSValue ns) {
    (void) ctx;
    (void) ns;
}
#endif

#endif
