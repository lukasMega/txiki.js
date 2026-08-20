# Everything this fork adds on top of upstream's build: the extra feature
# switches (TLS, WebCrypto, the bundled CA, compressed bytecode) and the
# size/hardening levers.
#
# It lives in its own file so the fork's delta inside CMakeLists.txt stays a
# handful of call sites rather than ~160 interleaved lines. Upstream touches
# CMakeLists.txt often, and every line we put *inside* a file it also edits is a
# recurring merge conflict.
#
# CMake is imperative, so this cannot be a single include: the directory-scoped
# flags below must run before any target or dependency exists, while the rest has
# to run after the target it configures. Hence one include plus the
# tjs_slim_configure_* functions, each called at the one point where it is valid.
#
# Requires: the `xoption` macro from CMakeLists.txt, and inclusion at top-level
# directory scope (xoption calls add_definitions()).

xoption(BUILD_WITH_TLS "If ON (default), build with TLS support (HTTPS/WSS/TLSSocket)" ON)
xoption(BUILD_WITH_BUNDLED_CA "If ON (default, TLS builds only), embed the Mozilla CA bundle in the binary, otherwise rely on TJS_CA_BUNDLE/setCABundlePath or the OS trust store" ON)
# LITE-profile-only, WinterTC-breaking: drops crypto.subtle (webcrypto.c,
# ed25519.c/tweetnacl). crypto.getRandomValues/randomUUID are unaffected
# (backed by src/mod_os.c, not webcrypto.c). Never default OFF.
xoption(BUILD_WITH_WEBCRYPTO "If ON (default), build WebCrypto (crypto.subtle). If OFF, drops crypto.subtle (getRandomValues/randomUUID still work) -- LITE profile only, WinterTC-breaking" ON)
xoption(BUILD_WITH_COMPRESSED_BYTECODE "If ON, compress embedded JS bytecode with miniz (needs tjsc -z)" OFF)
# -Oz does strictly more size work than -Os, but is Clang-only. Rewrite only the
# *_MINSIZEREL flag strings so this is a no-op outside MinSizeRel builds.
xoption(BUILD_WITH_OZ "If ON, use Clang's -Oz (aggressive size) in MinSizeRel builds" OFF)
# Hidden default visibility lets the linker/LTO prune harder and shrinks the
# dynamic symbol table.
xoption(BUILD_WITH_HIDDEN_VISIBILITY "If ON, compile with -fvisibility=hidden" OFF)
xoption(BUILD_WITH_REPRODUCIBLE_PATHS "If ON, remap __FILE__/debug paths to strip the absolute source path" OFF)
xoption(BUILD_WITH_HARDENING "If ON, enable exploit-mitigation flags (stack protector, zero-init, arm64 PAC/BTI, FORTIFY)" OFF)
xoption(BUILD_WITH_NO_UNWIND_TABLES "EXPERIMENTAL: drop async unwind/.eh_frame tables" OFF)
xoption(BUILD_WITH_ICF "If ON, fold identical functions at link (lld/gold, ELF only)" OFF)

###
### Directory-scoped compile flags.
###
### These must be in effect before the first add_library/add_subdirectory so they
### also cover the vendored deps, which is why the include sits where it does.
###

if(BUILD_WITH_OZ)
    if(CMAKE_C_COMPILER_ID MATCHES "Clang")
        string(REPLACE "-Os" "-Oz" CMAKE_C_FLAGS_MINSIZEREL   "${CMAKE_C_FLAGS_MINSIZEREL}")
        string(REPLACE "-Os" "-Oz" CMAKE_CXX_FLAGS_MINSIZEREL "${CMAKE_CXX_FLAGS_MINSIZEREL}")
        message(STATUS "Using -Oz for MinSizeRel")
    else()
        message(WARNING "BUILD_WITH_OZ requested but compiler is not Clang; keeping -Os")
    endif()
endif()

if(BUILD_WITH_HIDDEN_VISIBILITY AND NOT MSVC)
    add_compile_options(-fvisibility=hidden)
    # -fvisibility-inlines-hidden is C++-only; gate it with a generator
    # expression to avoid -Wunused-command-line-argument on the C TUs.
    add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-fvisibility-inlines-hidden>)
endif()

# Strip the absolute build path from the binary. The CHECK/assert macros
# (src/utils.h) and libuv/lws embed __FILE__, which otherwise bakes the full
# source path -- e.g. /Users/<you>/.../src/vm.c -- into the binary as plain string
# data (__cstring) that BUILD_WITH_STRIP cannot remove. -ffile-prefix-map rewrites
# __FILE__ (and debug paths) at compile time for every TU, also giving
# reproducible builds.
if(BUILD_WITH_REPRODUCIBLE_PATHS AND NOT MSVC)
    add_compile_options(-ffile-prefix-map=${CMAKE_SOURCE_DIR}=.)
endif()

# Exploit-mitigation flags for distributed binaries. Low-risk, broadly applicable
# set only (verified to compile on Apple clang arm64). PIE/ASLR is already the
# macOS default; ELF-only knobs (RELRO, -z now, noexecstack) and x86 CET
# (-fcf-protection) do not apply to Mach-O and are omitted. Clang CFI
# (-fsanitize=cfi) is intentionally NOT used: it breaks tjs:ffi's dlopen of
# external libraries.
if(BUILD_WITH_HARDENING AND NOT MSVC)
    add_compile_options(-fstack-protector-strong)
    add_compile_options(-ftrivial-auto-var-init=zero)
    # FORTIFY_SOURCE needs optimization; harmless (and a no-op warning) at -O0.
    add_compile_options($<$<NOT:$<CONFIG:Debug>>:-D_FORTIFY_SOURCE=2>)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
        # PAC return-address signing + BTI (ROP/JOP mitigation) on AArch64.
        add_compile_options(-mbranch-protection=standard)
    endif()
endif()

# EXPERIMENTAL: -fno-asynchronous-unwind-tables drops the *async* unwind tables
# (.eh_frame / __unwind_info) used for signal/profiler backtraces. We deliberately
# do NOT use -fno-unwind-tables: ada is C++ and relies on synchronous unwind for
# exceptions. Dropping async tables keeps exceptions working but breaks
# crash/signal backtraces, so this stays OFF by default.
if(BUILD_WITH_NO_UNWIND_TABLES AND NOT MSVC)
    add_compile_options(-fno-asynchronous-unwind-tables)
endif()

###
### Per-target configuration.
###

# Upstream lists cacert.c, mod_tls.c, ed25519.c and webcrypto.c unconditionally in
# add_library(tjs ...); this fork makes each optional. Dropping them from the
# target's SOURCES property afterwards keeps that list byte-identical to
# upstream's -- it is the churniest part of the file, since every new native
# module adds a line to it.
#
# The membership check is not defensive: a rename upstream would otherwise make
# this a silent no-op and quietly compile the file back in.
function(_tjs_slim_drop_source target src)
    get_target_property(_srcs ${target} SOURCES)
    if(NOT "${src}" IN_LIST _srcs)
        message(FATAL_ERROR
            "slim: '${src}' is not a source of target '${target}'. Upstream renamed "
            "or removed it; update cmake/slim.cmake.")
    endif()
    list(REMOVE_ITEM _srcs "${src}")
    set_property(TARGET ${target} PROPERTY SOURCES ${_srcs})
endfunction()

# Call after the add_library(tjs ...) block and its conditional target_sources().
function(tjs_slim_configure_core)
    if(BUILD_WITH_WEBCRYPTO)
        target_compile_definitions(tjs PRIVATE TJS_HAVE_WEBCRYPTO)
    else()
        _tjs_slim_drop_source(tjs src/ed25519.c)
        _tjs_slim_drop_source(tjs src/webcrypto.c)
    endif()

    if(BUILD_WITH_TLS)
        target_compile_definitions(tjs PRIVATE TJS_HAVE_TLS)
    else()
        _tjs_slim_drop_source(tjs src/mod_tls.c)
    endif()

    # The embedded CA bundle only makes sense (and is only referenced) when TLS is
    # built in; BUILD_WITH_BUNDLED_CA is a TLS-on-only opt-out.
    if(BUILD_WITH_TLS AND BUILD_WITH_BUNDLED_CA)
        target_sources(tjs PRIVATE src/cacert_inflate.c)
        target_compile_definitions(tjs PRIVATE TJS_HAVE_BUNDLED_CA)
    else()
        _tjs_slim_drop_source(tjs src/cacert.c)
    endif()

    # Embedded JS bytecode is decompressed at load (eval.c/builtins.c) when this is
    # defined; the bundles must then be generated with `tjsc -z` (Makefile
    # TJSC_COMPRESS=-z). Both are driven together by the build:smallest* tasks.
    if(BUILD_WITH_COMPRESSED_BYTECODE)
        target_compile_definitions(tjs PRIVATE TJS_COMPRESSED_BYTECODE)
    endif()
endfunction()

# Call after the tjs-cli target exists and after upstream's BUILD_WITH_GC_SECTIONS
# link block.
#
# Identical-code folding needs lld or gold; classic GNU bfd ld and Apple ld64 have
# no --icf, and MSVC already folds via /OPT:ICF in the GC_SECTIONS block, so this
# targets the ELF linkers only. --icf=safe folds only functions the compiler
# marked address-insignificant (Clang emits these by default), so function-pointer
# identity is preserved; --icf=all saves more but is unsafe.
function(tjs_slim_configure_cli)
    if(NOT BUILD_WITH_ICF OR APPLE OR MSVC)
        return()
    endif()
    # The default ELF linker on most distros is still GNU bfd ld, which rejects
    # --icf outright ("unrecognized option"), so probe before adding it rather
    # than breaking every link on a toolchain that cannot fold.
    if(CMAKE_VERSION VERSION_GREATER_EQUAL 3.18)
        include(CheckLinkerFlag)
        check_linker_flag(C "-Wl,--icf=safe" TJS_HAVE_ICF)
    else()
        set(TJS_HAVE_ICF TRUE)
    endif()
    if(TJS_HAVE_ICF)
        target_link_options(tjs-cli PRIVATE -Wl,--icf=safe)
    else()
        message(WARNING "BUILD_WITH_ICF requested but the linker has no --icf (needs lld or gold); skipping")
    endif()
endfunction()

# Call after add_subdirectory(deps/ada).
#
# URLPattern is provided by the urlpattern-polyfill JS bundle; ada's C++
# implementation is unused -- compile it out (~45 KiB of dead code).
function(tjs_slim_configure_ada)
    target_compile_definitions(ada PRIVATE ADA_INCLUDE_URL_PATTERN=0)
endfunction()

# Call after add_subdirectory(deps/miniz).
#
# tjsc (qjsc.c) includes miniz.h for the optional -z bytecode compression.
function(tjs_slim_configure_miniz)
    target_link_libraries(tjsc miniz)
endfunction()

# Replaces upstream's unconditional
# `target_link_libraries(tjs PUBLIC mbedtls mbedx509 mbedcrypto)`.
#
# libmbedcrypto is always linked: besides webcrypto.c, src/mod_hashing.c (the
# always-on tjs:hashing Hash class -- md5/sha1/sha256/sha512/sha3) depends on it
# directly and unconditionally, independent of BUILD_WITH_TLS and
# BUILD_WITH_WEBCRYPTO. (Originally planned to drop mbedcrypto entirely when both
# TLS and WebCrypto are off; not possible without also gating mod_hashing.c, which
# is a general-purpose hashing API, not part of WebCrypto.) The TLS protocol layer
# (mbedtls) and certificate parsing (mbedx509) are only needed when
# BUILD_WITH_TLS is on.
function(tjs_slim_link_mbedtls)
    if(BUILD_WITH_TLS)
        target_link_libraries(tjs PUBLIC mbedtls mbedx509 mbedcrypto)
    else()
        target_link_libraries(tjs PUBLIC mbedcrypto)
    endif()
endfunction()

# Call after upstream's LWS_* block and before add_subdirectory(deps/libwebsockets).
# These are cache entries set with FORCE, so overriding upstream's values here is
# purely additive -- the last FORCE wins.
function(tjs_slim_lws_options)
    if(BUILD_WITH_TLS)
        set(LWS_WITH_MBEDTLS ON CACHE BOOL "" FORCE)
        set(LWS_WITH_SSL ON CACHE BOOL "" FORCE)
    else()
        set(LWS_WITH_MBEDTLS OFF CACHE BOOL "" FORCE)
        set(LWS_WITH_SSL OFF CACHE BOOL "" FORCE)
    endif()

    # lws defaults SChannel ON for Windows builds that pick no other TLS backend,
    # so a BUILD_WITH_TLS=OFF Windows build compiled schannel-ssl.c alongside the
    # no-ssl stubs and failed to link. We only ever use mbedtls.
    set(LWS_WITH_SCHANNEL OFF CACHE BOOL "" FORCE)

    # NOTE: lws only implements LWS_SSL_CLIENT_USE_OS_CA_CERTS for the OpenSSL and
    # SChannel TLS backends (lib/tls/openssl/openssl-client.c,
    # lib/plat/windows/windows-sockets.c -- the latter explicitly #ifs out
    # LWS_WITH_MBEDTLS). We build lws with LWS_WITH_MBEDTLS whenever TLS is on, so
    # this is a no-op for every platform txiki.js targets today; it is set
    # defensively (harmless) in case that ever changes. With the embedded bundle
    # compiled out (BUILD_WITH_BUNDLED_CA=OFF), the only supported CA sources are
    # TJS_CA_BUNDLE/setCABundlePath -- without one, HTTPS/WSS fails cert
    # verification with a clear mbedtls/lws error rather than skipping it.
    if(BUILD_WITH_TLS AND NOT BUILD_WITH_BUNDLED_CA)
        set(LWS_SSL_CLIENT_USE_OS_CA_CERTS ON CACHE BOOL "" FORCE)
    else()
        set(LWS_SSL_CLIENT_USE_OS_CA_CERTS OFF CACHE BOOL "" FORCE)
    endif()
endfunction()
