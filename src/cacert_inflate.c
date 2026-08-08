/*
 * txiki.js
 *
 * Copyright (c) 2019-present Saúl Ibarra Corretgé <s@saghul.net>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/*
 * Lazy inflate + cache for the embedded (miniz-compressed) CA bundle. Kept
 * separate from the generated src/cacert.c so the generator
 * (scripts/update-ca-bundle.sh) only ever needs to emit data, never logic.
 *
 * Only compiled when TJS_HAVE_BUNDLED_CA is defined (BUILD_WITH_TLS AND
 * BUILD_WITH_BUNDLED_CA both ON), same gate as src/cacert.c.
 */

#include "cacert.h"
#include "mem.h"
#include "miniz.h"
#include "private.h"

#ifdef TJS_HAVE_BUNDLED_CA

const char *tjs__cacert_pem(TJSRuntime *qrt, size_t *out_len) {
    if (!qrt->tls.cacert_pem_inflated) {
        if (tjs_cacert_pem_gz_size < 4) {
            return NULL;
        }

        mz_ulong raw_len = (mz_ulong) tjs_cacert_pem_gz[0] | ((mz_ulong) tjs_cacert_pem_gz[1] << 8) |
                           ((mz_ulong) tjs_cacert_pem_gz[2] << 16) | ((mz_ulong) tjs_cacert_pem_gz[3] << 24);

        uint8_t *raw = tjs__malloc(raw_len ? raw_len : 1);
        if (!raw) {
            return NULL;
        }

        mz_ulong got_len = raw_len;
        int zr = mz_uncompress(raw, &got_len, tjs_cacert_pem_gz + 4, (mz_ulong) (tjs_cacert_pem_gz_size - 4));
        if (zr != MZ_OK || got_len != raw_len || raw_len == 0) {
            tjs__free(raw);
            return NULL;
        }

        /* Blob's raw_len includes the trailing NUL (mbedtls PEM parsing
         * requires a NUL-terminated buffer); cache the length without it,
         * matching the old sizeof(...) - 1 convention. */
        qrt->tls.cacert_pem_inflated = (char *) raw;
        qrt->tls.cacert_pem_inflated_len = (size_t) raw_len - 1;
    }

    if (out_len) {
        *out_len = qrt->tls.cacert_pem_inflated_len;
    }
    return qrt->tls.cacert_pem_inflated;
}

#endif /* TJS_HAVE_BUNDLED_CA */
