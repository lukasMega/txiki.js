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

#include "private.h"

#ifdef TJS_COMPRESSED_BYTECODE
#include "miniz.h"
#endif


JSValue tjs__read_bytecode(JSContext *ctx, const uint8_t *buf, size_t buf_len) {
#ifdef TJS_COMPRESSED_BYTECODE
    /* Compressed blob: [uint32 LE raw_len][zlib stream]. */
    if (buf_len < 4) {
        return JS_ThrowInternalError(ctx, "compressed bytecode too short");
    }
    mz_ulong raw_len =
        (mz_ulong) buf[0] | ((mz_ulong) buf[1] << 8) | ((mz_ulong) buf[2] << 16) | ((mz_ulong) buf[3] << 24);
    uint8_t *raw = js_malloc(ctx, raw_len ? raw_len : 1);
    if (!raw) {
        return JS_ThrowOutOfMemory(ctx);
    }
    mz_ulong out_len = raw_len;
    int zr = mz_uncompress(raw, &out_len, buf + 4, (mz_ulong) (buf_len - 4));
    if (zr != MZ_OK || out_len != raw_len) {
        js_free(ctx, raw);
        return JS_ThrowInternalError(ctx, "failed to decompress bytecode (%d)", zr);
    }
    JSValue obj = JS_ReadObject(ctx, raw, raw_len, JS_READ_OBJ_BYTECODE);
    js_free(ctx, raw);
    return obj;
#else
    return JS_ReadObject(ctx, buf, buf_len, JS_READ_OBJ_BYTECODE);
#endif
}

int tjs__eval_bytecode(JSContext *ctx, const uint8_t *buf, size_t buf_len, bool check_promise) {
    JSValue obj = tjs__read_bytecode(ctx, buf, buf_len);

    if (JS_IsException(obj)) {
        goto error;
    }

    if (JS_VALUE_GET_TAG(obj) == JS_TAG_MODULE) {
        if (JS_ResolveModule(ctx, obj) < 0) {
            JS_FreeValue(ctx, obj);
            goto error;
        }

        js_module_set_import_meta(ctx, obj, false, false);
    }

    JSValue val = JS_EvalFunction(ctx, obj);
    if (JS_IsException(val)) {
        goto error;
    }

    if (check_promise) {
        JSPromiseStateEnum promise_state = JS_PromiseState(ctx, val);
        if (promise_state != JS_PROMISE_NOT_A_PROMISE) {
            // It's a promise!
            if (promise_state == JS_PROMISE_REJECTED) {
                JSValue res = JS_PromiseResult(ctx, val);
                tjs_dump_error1(ctx, res);
                JS_FreeValue(ctx, res);
                JS_FreeValue(ctx, val);

                return -1;
            }
        }
    }

    JS_FreeValue(ctx, val);

    return 0;

error:
    tjs_dump_error(ctx);
    return -1;
}
