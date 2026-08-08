import core from 'tjs:internal/core';

/*
 * Builds with BUILD_WITH_WEBCRYPTO=OFF don't register core.webcrypto at all.
 * crypto.subtle is never exposed in that case (see crypto.js), so none of
 * these native bindings are ever actually *called* -- but a handful of them
 * (nativeCipher, nativeAesKw, nativeEcGenerateKey, nativeDigest) have their
 * static constant properties (e.g. nativeDigest.DIGEST_SHA1) read right here
 * and in aes.js at *module* scope, which runs unconditionally at import time
 * as part of the always-bundled polyfills bytecode. Give those four concrete
 * stand-ins with the expected constant shape so that top-level evaluation
 * never dereferences a property of undefined; everything else is fine as
 * plain `undefined` since it's only ever invoked from inside SubtleCrypto
 * methods, which are unreachable when crypto.subtle doesn't exist.
 */
function unavailable() {
    throw new DOMException('WebCrypto is not available in this build', 'NotSupportedError');
}

const webcrypto = core.webcrypto ?? {
    cipher: Object.assign(unavailable, {
        CIPHER_AES_CBC: -1, CIPHER_AES_GCM: -2, CIPHER_AES_CTR: -3,
        CIPHER_OP_ENCRYPT: -1, CIPHER_OP_DECRYPT: -2,
    }),
    aesKw: Object.assign(unavailable, { AES_KW_OP_WRAP: -1, AES_KW_OP_UNWRAP: -2 }),
    ecGenerateKey: Object.assign(unavailable, { CURVE_P256: -1, CURVE_P384: -2, CURVE_P521: -3 }),
    digest: Object.assign(unavailable, {
        DIGEST_SHA1: -1, DIGEST_SHA256: -2, DIGEST_SHA384: -3, DIGEST_SHA512: -4,
    }),
};

export const nativeDigest = webcrypto.digest;
export const nativeHmacSign = webcrypto.hmacSign;
export const nativeCipher = webcrypto.cipher;
export const nativePbkdf2 = webcrypto.pbkdf2;
export const nativeHkdf = webcrypto.hkdf;
export const nativeEcGenerateKey = webcrypto.ecGenerateKey;
export const nativeEcdsaSign = webcrypto.ecdsaSign;
export const nativeEcdsaVerify = webcrypto.ecdsaVerify;
export const nativeEcdhDeriveBits = webcrypto.ecdhDeriveBits;
export const nativeRsaGenerateKey = webcrypto.rsaGenerateKey;
export const nativeRsaOaepEncrypt = webcrypto.rsaOaepEncrypt;
export const nativeRsaOaepDecrypt = webcrypto.rsaOaepDecrypt;
export const nativeRsaSign = webcrypto.rsaSign;
export const nativeRsaVerify = webcrypto.rsaVerify;
export const nativeRsaParseKey = webcrypto.rsaParseKey;
export const nativeEcParseKey = webcrypto.ecParseKey;
export const nativeEcKeyToDer = webcrypto.ecKeyToDer;
export const nativeRsaExportJwk = webcrypto.rsaExportJwk;
export const nativeRsaImportJwk = webcrypto.rsaImportJwk;
export const nativeEcGetPublicKey = webcrypto.ecGetPublicKey;
export const nativeEd25519GenerateKey = webcrypto.ed25519GenerateKey;
export const nativeEd25519Sign = webcrypto.ed25519Sign;
export const nativeEd25519Verify = webcrypto.ed25519Verify;
export const nativeEd25519GetPublicKey = webcrypto.ed25519GetPublicKey;
export const nativeX25519GenerateKey = webcrypto.x25519GenerateKey;
export const nativeX25519DeriveBits = webcrypto.x25519DeriveBits;
export const nativeX25519GetPublicKey = webcrypto.x25519GetPublicKey;
export const nativeAesKw = webcrypto.aesKw;

export const curveIdToName = {
    [nativeEcGenerateKey.CURVE_P256]: 'P-256',
    [nativeEcGenerateKey.CURVE_P384]: 'P-384',
    [nativeEcGenerateKey.CURVE_P521]: 'P-521',
};

export const digestAlgorithms = {
    'SHA-1':   nativeDigest.DIGEST_SHA1,
    'SHA-256': nativeDigest.DIGEST_SHA256,
    'SHA-384': nativeDigest.DIGEST_SHA384,
    'SHA-512': nativeDigest.DIGEST_SHA512,
};

export const hashBlockSizes = {
    'SHA-1':   64,
    'SHA-256': 64,
    'SHA-384': 128,
    'SHA-512': 128,
};

export function toUint8Array(data) {
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    throw new TypeError('data must be a BufferSource');
}

export const curveAlgorithms = {
    'P-256': nativeEcGenerateKey.CURVE_P256,
    'P-384': nativeEcGenerateKey.CURVE_P384,
    'P-521': nativeEcGenerateKey.CURVE_P521,
};

export function normalizeCurve(namedCurve) {
    const canonical = Object.keys(curveAlgorithms).find(k => k.toUpperCase() === namedCurve.toUpperCase());

    if (!canonical) {
        throw new DOMException(`Unrecognized named curve: ${namedCurve}`, 'NotSupportedError');
    }

    return canonical;
}

export function normalizeHashAlgorithm(hash) {
    const name = typeof hash === 'string' ? hash : hash?.name;

    if (!name) {
        throw new DOMException(`Unrecognized hash algorithm: ${name}`, 'NotSupportedError');
    }

    const canonical = Object.keys(digestAlgorithms).find(k => k.toUpperCase() === name.toUpperCase());

    if (!canonical) {
        throw new DOMException(`Unrecognized hash algorithm: ${name}`, 'NotSupportedError');
    }

    return canonical;
}

export function base64urlEncode(bytes) {
    let binary = '';

    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');

    const pad = (4 - (str.length % 4)) % 4;

    str += '='.repeat(pad);

    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}
