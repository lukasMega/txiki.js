cmake_minimum_required(VERSION 3.14)

cmake_policy(SET CMP0091 NEW)

project(tjs LANGUAGES C CXX)

include(ExternalProject)
include(GNUInstallDirs)

if (NOT CMAKE_BUILD_TYPE)
    message(STATUS "No build type selected, default to Release")
    set(CMAKE_BUILD_TYPE "Release")
endif()
message(STATUS "Building in ${CMAKE_BUILD_TYPE} mode")
message(STATUS "Building with ${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION} on ${CMAKE_SYSTEM}")

set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_C_STANDARD 11)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    list(APPEND tjs_cflags /experimental:c11atomics)
else()
    list(APPEND tjs_cflags -Wall -g)
    if(UNIX)
        # Treat warnings as errors, but only on Unix; Windows toolchains warn differently.
        list(APPEND tjs_cflags -Werror)
    endif()
    if (CMAKE_BUILD_TYPE MATCHES "Debug")
        list(APPEND tjs_cflags -ggdb -O0 -fno-omit-frame-pointer)
    endif()
endif()

set(TJS__VERSION_MAJOR 26)
set(TJS__VERSION_MINOR 6)
set(TJS__VERSION_PATCH 0)
set(TJS__VERSION_SUFFIX "")
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/src/version.h.in"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/version.h"
)

macro(xoption OPTION_NAME OPTION_TEXT OPTION_DEFAULT)
    option(${OPTION_NAME} ${OPTION_TEXT} ${OPTION_DEFAULT})
    if(DEFINED ENV{${OPTION_NAME}})
        # Allow setting the option through an environment variable
        set(${OPTION_NAME} $ENV{${OPTION_NAME}})
    endif()
    if(${OPTION_NAME})
        add_definitions(-D${OPTION_NAME})
    endif()
    message(STATUS "  ${OPTION_NAME}: ${${OPTION_NAME}}")
endmacro()

xoption(BUILD_WITH_MIMALLOC "If ON (default), build with mimalloc" ON)
xoption(BUILD_WITH_FFI "If ON (default), build with libffi (the tjs:ffi module)" ON)
xoption(BUILD_WITH_ASAN "Build with AddressSanitizer" OFF)
xoption(BUILD_WITH_UBSAN "Build with UndefinedBehaviorSanitizer" OFF)
xoption(BUILD_WITH_GC_STRESS "Force a full GC before every JS allocation (QuickJS FORCE_GC_AT_MALLOC)" OFF)
xoption(BUILD_WITH_WASM "If ON (default), build with WASM/WAMR support" ON)
xoption(BUILD_WITH_SQLITE "If ON (default), build with SQLite (the tjs:sqlite module)" ON)
xoption(BUILD_WITH_STRIP "If ON, strip the tjs binary after linking" OFF)
xoption(BUILD_WITH_LTO "If ON, enable link-time optimization" OFF)
xoption(BUILD_WITH_GC_SECTIONS "If ON, compile with per-function/data sections and link with dead-code stripping" OFF)
# -Oz does strictly more size work than -Os, but is Clang-only. Rewrite only the
# *_MINSIZEREL flag strings so this is a no-op outside MinSizeRel builds.
xoption(BUILD_WITH_OZ "If ON, use Clang's -Oz (aggressive size) in MinSizeRel builds" OFF)
xoption(BUILD_WITH_TLS "If ON (default), build with TLS support (HTTPS/WSS/TLSSocket)" ON)
xoption(BUILD_WITH_COMPRESSED_BYTECODE "If ON, compress embedded JS bytecode with miniz (needs tjsc -z)" OFF)

if(BUILD_WITH_GC_STRESS)
    message(STATUS "GC stress mode enabled (FORCE_GC_AT_MALLOC)")
    # quickjs.c only runs a GC when this is defined; the definition is set at
    # directory scope here so it propagates to the deps/quickjs subdirectory
    # added below.
    add_compile_definitions(FORCE_GC_AT_MALLOC)
endif()

if(BUILD_WITH_ASAN)
    message(STATUS "AddressSanitizer enabled")
    if(BUILD_WITH_MIMALLOC)
        message(FATAL_ERROR "BUILD_WITH_ASAN and BUILD_WITH_MIMALLOC cannot be used together")
    endif()
    add_compile_definitions(TJS__HAS_ASAN)
    if(MSVC)
        add_compile_options(/fsanitize=address)
    else()
        add_compile_options(-fsanitize=address -fno-omit-frame-pointer -fno-sanitize-recover=all)
        add_link_options(-fsanitize=address)
    endif()
endif()

if(BUILD_WITH_UBSAN)
    message(STATUS "UndefinedBehaviorSanitizer enabled")
    if(MSVC)
        message(FATAL_ERROR "BUILD_WITH_UBSAN is not supported with MSVC")
    endif()
    add_compile_options(-fsanitize=undefined -fno-omit-frame-pointer)
    add_link_options(-fsanitize=undefined)
endif()

if(BUILD_WITH_LTO)
    include(CheckIPOSupported)
    check_ipo_supported(RESULT _ipo_supported OUTPUT _ipo_output)
    if(_ipo_supported)
        message(STATUS "LTO enabled")
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
    else()
        message(WARNING "LTO requested but not supported: ${_ipo_output}")
    endif()
endif()

if(BUILD_WITH_GC_SECTIONS)
    if(MSVC)
        add_compile_options(/Gy)
    else()
        add_compile_options(-ffunction-sections -fdata-sections)
    endif()
endif()

if(BUILD_WITH_OZ)
    if(CMAKE_C_COMPILER_ID MATCHES "Clang")
        string(REPLACE "-Os" "-Oz" CMAKE_C_FLAGS_MINSIZEREL   "${CMAKE_C_FLAGS_MINSIZEREL}")
        string(REPLACE "-Os" "-Oz" CMAKE_CXX_FLAGS_MINSIZEREL "${CMAKE_CXX_FLAGS_MINSIZEREL}")
        message(STATUS "Using -Oz for MinSizeRel")
    else()
        message(WARNING "BUILD_WITH_OZ requested but compiler is not Clang; keeping -Os")
    endif()
endif()

# Hidden default visibility lets the linker/LTO prune harder and shrinks the
# dynamic symbol table. -fvisibility-inlines-hidden is C++-only, so gate it with
# a generator expression to avoid -Wunused-command-line-argument on C TUs.
# Placed before any add_library/add_subdirectory so it also covers vendored deps.
xoption(BUILD_WITH_HIDDEN_VISIBILITY "If ON, compile with -fvisibility=hidden" OFF)
if(BUILD_WITH_HIDDEN_VISIBILITY AND NOT MSVC)
    add_compile_options(-fvisibility=hidden)
    add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-fvisibility-inlines-hidden>)
endif()

# Strip the absolute build path from the binary. The CHECK/assert macros
# (src/utils.h) and libuv/lws embed __FILE__, which otherwise bakes the full
# source path — e.g. /Users/<you>/.../src/vm.c — into the binary as plain string
# data (__cstring) that BUILD_WITH_STRIP cannot remove. -ffile-prefix-map rewrites
# __FILE__ (and debug paths) at compile time for every TU, also giving
# reproducible builds. Placed before add_subdirectory so it covers vendored deps.
xoption(BUILD_WITH_REPRODUCIBLE_PATHS "If ON, remap __FILE__/debug paths to strip the absolute source path" OFF)
if(BUILD_WITH_REPRODUCIBLE_PATHS AND NOT MSVC)
    add_compile_options(-ffile-prefix-map=${CMAKE_SOURCE_DIR}=.)
endif()

# Exploit-mitigation flags for distributed binaries. Low-risk, broadly applicable
# set only (verified to compile on Apple clang arm64). PIE/ASLR is already the
# macOS default; ELF-only knobs (RELRO, -z now, noexecstack) and x86 CET
# (-fcf-protection) do not apply to Mach-O and are omitted. Clang CFI
# (-fsanitize=cfi) is intentionally NOT used: it breaks tjs:ffi's dlopen of
# external libraries. Placed before add_subdirectory so it also covers deps.
xoption(BUILD_WITH_HARDENING "If ON, enable exploit-mitigation flags (stack protector, zero-init, arm64 PAC/BTI, FORTIFY)" OFF)
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
xoption(BUILD_WITH_NO_UNWIND_TABLES "EXPERIMENTAL: drop async unwind/.eh_frame tables" OFF)
if(BUILD_WITH_NO_UNWIND_TABLES AND NOT MSVC)
    add_compile_options(-fno-asynchronous-unwind-tables)
endif()

###
### Core library / executables
###

add_library(tjs STATIC
    src/builtins.c
    src/cacert.c
    src/error.c
    src/lws-evlib.c
    src/lws-utils.c
    src/eval.c
    src/mem.c
    src/modules.c
    src/tbuf.c
    src/signals.c
    src/text-coding.c
    src/timers.c
    src/utils.c
    src/version.c
    src/vm.c
    src/worker.c
    src/ws.c
    src/httpclient.c
    src/httpserver.c
    src/mod_channel.c
    src/mod_dns.c
    src/mod_engine.c
    src/mod_fs.c
    src/mod_fswatch.c
    src/mod_hashing.c
    src/mod_os.c
    src/mod_process.c
    src/mod_miniz.c
    src/mod_streams.c
    src/ed25519.c
    src/webcrypto.c
    src/mod_sys.c
    src/mod_udp.c
    src/url.c
    src/bundles/c/core/core.c
    src/bundles/c/core/polyfills.c
    src/bundles/c/core/run-main.c
    src/bundles/c/core/run-repl.c
    src/bundles/c/core/worker-bootstrap.c
)

if(UNIX)
    target_sources(tjs PRIVATE src/mod_posix-socket.c)
endif()

if(BUILD_WITH_WASM)
    target_sources(tjs PRIVATE src/wasm.c)
    target_compile_definitions(tjs PRIVATE TJS_HAVE_WASM)
endif()

if(BUILD_WITH_SQLITE)
    target_sources(tjs PRIVATE src/mod_sqlite3.c)
    target_compile_definitions(tjs PRIVATE TJS_HAVE_SQLITE)
endif()

if(BUILD_WITH_TLS)
    target_sources(tjs PRIVATE src/mod_tls.c)
    target_compile_definitions(tjs PRIVATE TJS_HAVE_TLS)
endif()

# Embedded JS bytecode is decompressed at load (eval.c/builtins.c) when this is
# defined; the bundles must then be generated with `tjsc -z` (Makefile
# TJSC_COMPRESS=-z). Both are driven together by the build:smallest* tasks.
if(BUILD_WITH_COMPRESSED_BYTECODE)
    target_compile_definitions(tjs PRIVATE TJS_COMPRESSED_BYTECODE)
endif()

set_target_properties(tjs PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED ON
    OUTPUT_NAME tjs_core
)

string(TOLOWER ${CMAKE_SYSTEM_NAME} TJS_PLATFORM)
target_compile_options(tjs PRIVATE ${tjs_cflags})
target_compile_definitions(tjs PRIVATE TJS__PLATFORM="${TJS_PLATFORM}")

if(WIN32)
    target_compile_definitions(tjs PRIVATE WIN32_LEAN_AND_MEAN)
endif()

target_include_directories(tjs PUBLIC src)

add_executable(tjs-cli
    src/cli.c
)
target_link_libraries(tjs-cli tjs)
set_target_properties(tjs-cli
    PROPERTIES OUTPUT_NAME tjs
)
# On Windows with MSVC the stack size if by default 1MB, same as our engine.
# Bump it up to 8MB.
if(WIN32)
    target_link_options(tjs-cli PRIVATE "/STACK:8388608")
endif()

if(BUILD_WITH_STRIP AND CMAKE_STRIP)
    add_custom_command(TARGET tjs-cli POST_BUILD
        COMMAND ${CMAKE_STRIP} $<TARGET_FILE:tjs-cli>
        COMMENT "Stripping tjs"
    )
endif()

if(BUILD_WITH_GC_SECTIONS)
    if(MSVC)
        target_link_options(tjs-cli PRIVATE /OPT:REF /OPT:ICF)
    elseif(APPLE)
        target_link_options(tjs-cli PRIVATE -Wl,-dead_strip)
    else()
        target_link_options(tjs-cli PRIVATE -Wl,--gc-sections)
    endif()
endif()

# Identical-code folding. Needs lld or gold; classic GNU bfd ld and Apple ld64
# have no --icf, and MSVC already folds via /OPT:ICF in the GC_SECTIONS block
# above, so this targets the ELF linkers only. --icf=safe folds only functions
# the compiler marked address-insignificant (Clang emits these by default), so
# function-pointer identity is preserved; --icf=all saves more but is unsafe.
xoption(BUILD_WITH_ICF "If ON, fold identical functions at link (lld/gold, ELF only)" OFF)
if(BUILD_WITH_ICF AND NOT APPLE AND NOT MSVC)
    target_link_options(tjs-cli PRIVATE -Wl,--icf=safe)
endif()

add_executable(tjsc EXCLUDE_FROM_ALL
    src/qjsc.c
)

###
### Dependencies
###

add_subdirectory(deps/quickjs EXCLUDE_FROM_ALL)
target_link_libraries(tjs PUBLIC qjs)
target_link_libraries(tjsc qjs)

if(BUILD_WITH_MIMALLOC)
    option(MI_OVERRIDE "" OFF)
    option(MI_BUILD_SHARED "" OFF)
    option(MI_BUILD_STATIC "" ON)
    option(MI_BUILD_OBJECT "" OFF)
    option(MI_BUILD_TESTS "" OFF)
    if(CMAKE_BUILD_TYPE MATCHES "Debug")
        option(MI_GUARDED "" ON)
    endif()
    add_subdirectory(deps/mimalloc EXCLUDE_FROM_ALL)
    target_compile_definitions(tjs PRIVATE TJS__HAS_MIMALLOC)
    target_link_libraries(tjs PUBLIC mimalloc-static)
endif()

option(libuv_buildtests "" OFF)
add_subdirectory(deps/libuv EXCLUDE_FROM_ALL)
target_link_libraries(tjs PUBLIC uv_a)

if(BUILD_WITH_SQLITE)
    add_subdirectory(deps/sqlite3 EXCLUDE_FROM_ALL)
    target_link_libraries(tjs PUBLIC sqlite3)
    add_library(sqlite-test SHARED
        tests/fixtures/sqlite-test-ext.c
    )
    target_link_libraries(sqlite-test sqlite3)
endif()

if(BUILD_WITH_FFI)
    target_sources(tjs PRIVATE src/mod_ffi.c)
    target_compile_definitions(tjs PRIVATE TJS_HAVE_FFI)
    if (WIN32)
        find_package(unofficial-libffi CONFIG REQUIRED)
        target_link_libraries(tjs PUBLIC unofficial::libffi::libffi)
    else()
        find_library(FFI_LIB NAMES libffi ffi REQUIRED)
        find_path(FFI_INCLUDE_DIR NAMES ffi.h PATH_SUFFIXES ffi REQUIRED)
        target_include_directories(tjs PRIVATE ${FFI_INCLUDE_DIR})
        target_link_libraries(tjs PUBLIC ${FFI_LIB})
    endif()
endif()

add_library(ffi-test SHARED
    tests/fixtures/ffi-test-lib.c
)

# Set consistent output for test libraries across all platforms (including MSVC multi-config)
set(_tjs_test_libs ffi-test)
if(BUILD_WITH_SQLITE)
    list(APPEND _tjs_test_libs sqlite-test)
endif()
set_target_properties(${_tjs_test_libs} PROPERTIES
    PREFIX "lib"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    # For multi-config generators (Visual Studio, Xcode)
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}"
    LIBRARY_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
    LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
    LIBRARY_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    LIBRARY_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}"
)

add_subdirectory(deps/ada EXCLUDE_FROM_ALL)
# URLPattern is provided by the urlpattern-polyfill JS bundle; ada's C++
# implementation is unused — compile it out (~45 KiB of dead code).
target_compile_definitions(ada PRIVATE ADA_INCLUDE_URL_PATTERN=0)
target_link_libraries(tjs PUBLIC ada)

if(BUILD_WITH_WASM)
# WAMR Configuration (interpreter only for maximum portability)
set(WAMR_ROOT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/deps/wamr)

# Detect platform for WAMR
if(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
    set(WAMR_BUILD_PLATFORM "darwin")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    set(WAMR_BUILD_PLATFORM "windows")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
    set(WAMR_BUILD_PLATFORM "android")
else()
    set(WAMR_BUILD_PLATFORM "linux")
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Darwin" AND NOT DEFINED WAMR_BUILD_TARGET AND CMAKE_OSX_ARCHITECTURES)
    set(TJS_OSX_ARCHITECTURES ${CMAKE_OSX_ARCHITECTURES})
    list(LENGTH TJS_OSX_ARCHITECTURES TJS_OSX_ARCHITECTURE_COUNT)

    if(TJS_OSX_ARCHITECTURE_COUNT EQUAL 1)
        list(GET TJS_OSX_ARCHITECTURES 0 TJS_OSX_ARCHITECTURE)
        string(TOLOWER "${TJS_OSX_ARCHITECTURE}" TJS_OSX_ARCHITECTURE)

        if(TJS_OSX_ARCHITECTURE MATCHES "^(arm64|aarch64)$")
            set(WAMR_BUILD_TARGET "AARCH64")
        elseif(TJS_OSX_ARCHITECTURE STREQUAL "x86_64")
            set(WAMR_BUILD_TARGET "X86_64")
        endif()
    endif()
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Android" AND NOT DEFINED WAMR_BUILD_TARGET)
    if(ANDROID_ABI STREQUAL "arm64-v8a")
        set(WAMR_BUILD_TARGET "AARCH64")
    elseif(ANDROID_ABI STREQUAL "x86_64")
        set(WAMR_BUILD_TARGET "X86_64")
    endif()
endif()

# Configure WAMR build options
set(WAMR_BUILD_INTERP 1)
set(WAMR_BUILD_FAST_INTERP 1)
set(WAMR_BUILD_AOT 0)
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_LIBC_BUILTIN 1)
set(WAMR_BUILD_LIBC_WASI 1)
set(WAMR_BUILD_MULTI_MODULE 1)
set(WAMR_BUILD_SIMD 1)
set(WAMR_BUILD_REF_TYPES 1)
set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_LIB_PTHREAD 0)
set(WAMR_BUILD_MINI_LOADER 0)
set(WAMR_DISABLE_HW_BOUND_CHECK 1)
set(WAMR_DISABLE_STACK_HW_BOUND_CHECK 1)

# Include WAMR build scripts
include(${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake)

add_library(vmlib STATIC ${WAMR_RUNTIME_LIB_SOURCE})
target_include_directories(vmlib PUBLIC ${WAMR_ROOT_DIR}/core/iwasm/include)
if(WIN32)
    target_link_libraries(vmlib PUBLIC ntdll)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    # WAMR's android platform logs via bionic liblog (__android_log_*).
    target_link_libraries(vmlib PUBLIC log)
endif()
target_include_directories(tjs PRIVATE ${WAMR_ROOT_DIR}/core/iwasm/include)
target_link_libraries(tjs PUBLIC vmlib)
endif()

add_subdirectory(deps/miniz EXCLUDE_FROM_ALL)
target_link_libraries(tjs PUBLIC miniz)
# tjsc (qjsc.c) includes miniz.h for the optional -z bytecode compression; link
# it here, after the miniz target exists.
target_link_libraries(tjsc miniz)

option(ENABLE_TESTING "" OFF)
option(ENABLE_PROGRAMS "" OFF)
option(MBEDTLS_FATAL_WARNINGS "" OFF)
set(MBEDTLS_AS_SUBPROJECT ON)
set(MBEDTLS_USER_CONFIG_FILE "${CMAKE_CURRENT_SOURCE_DIR}/src/mbedtls_config.h" CACHE FILEPATH "" FORCE)
set(MSVC_STATIC_RUNTIME ON CACHE BOOL "" FORCE)

# mbedTLS upstream has no QUIC support; patches/mbedtls-quic.patch adds it (from
# warmcat's quic-v3.6.6 mbedTLS branch — credit libwebsockets). Applied to the
# submodule work tree at configure time, idempotently via a forward/reverse
# apply --check.
find_package(Git QUIET)
if(NOT GIT_EXECUTABLE)
    set(GIT_EXECUTABLE git)
endif()
set(MBEDTLS_QUIC_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/mbedtls-quic.patch")
set(MBEDTLS_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/mbedtls")
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${MBEDTLS_SRC_DIR}" apply --check "${MBEDTLS_QUIC_PATCH}"
    RESULT_VARIABLE MBEDTLS_QUIC_FWD OUTPUT_QUIET ERROR_QUIET)
if(MBEDTLS_QUIC_FWD EQUAL 0)
    message(STATUS "Applying mbedTLS QUIC patch (HTTP/3 support)")
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${MBEDTLS_SRC_DIR}" apply "${MBEDTLS_QUIC_PATCH}"
        RESULT_VARIABLE MBEDTLS_QUIC_APPLY)
    if(NOT MBEDTLS_QUIC_APPLY EQUAL 0)
        message(FATAL_ERROR "Failed to apply ${MBEDTLS_QUIC_PATCH}")
    endif()
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${MBEDTLS_SRC_DIR}" apply --reverse --check "${MBEDTLS_QUIC_PATCH}"
        RESULT_VARIABLE MBEDTLS_QUIC_REV OUTPUT_QUIET ERROR_QUIET)
    if(MBEDTLS_QUIC_REV EQUAL 0)
        message(STATUS "mbedTLS QUIC patch already applied")
    else()
        message(FATAL_ERROR "mbedTLS QUIC patch neither applies nor is already applied; "
            "deps/mbedtls is in an unexpected state. Reset it with "
            "'git -C deps/mbedtls checkout .' and reconfigure.")
    endif()
endif()

add_subdirectory(deps/mbedtls EXCLUDE_FROM_ALL)
# libmbedcrypto is always linked: webcrypto.c depends on it directly. The TLS
# protocol layer (mbedtls) and certificate parsing (mbedx509) are only needed
# when BUILD_WITH_TLS is on.
if(BUILD_WITH_TLS)
    target_link_libraries(tjs PUBLIC mbedtls mbedx509 mbedcrypto)
else()
    target_link_libraries(tjs PUBLIC mbedcrypto)
endif()

if (NOT CMAKE_BUILD_TYPE MATCHES "Debug")
    set(LWS_WITH_NO_LOGS ON CACHE BOOL "" FORCE)
endif()
set(DISABLE_WERROR ON CACHE BOOL "" FORCE)
set(LWS_WITH_HTTP2 ON CACHE BOOL "" FORCE)
set(LWS_WITH_HTTP3 ON CACHE BOOL "" FORCE)
set(LWS_ROLE_QUIC ON CACHE BOOL "" FORCE)
set(LWS_ROLE_RAW_FILE OFF CACHE BOOL "" FORCE)
set(LWS_UNIX_SOCK OFF CACHE BOOL "" FORCE)
set(LWS_WITH_SYS_STATE OFF CACHE BOOL "" FORCE)
set(LWS_WITH_SYS_SMD OFF CACHE BOOL "" FORCE)
set(LWS_WITH_UPNG OFF CACHE BOOL "" FORCE)
set(LWS_WITH_DLO OFF CACHE BOOL "" FORCE)
set(LWS_WITH_SECURE_STREAMS OFF CACHE BOOL "" FORCE)
set(LWS_WITH_LEJP OFF CACHE BOOL "" FORCE)
set(LWS_WITH_LHP OFF CACHE BOOL "" FORCE)
set(LWS_WITH_JSONRPC OFF CACHE BOOL "" FORCE)
set(LWS_WITH_LWSAC OFF CACHE BOOL "" FORCE)
set(LWS_WITH_CONMON OFF CACHE BOOL "" FORCE)
set(LWS_WITH_WOL OFF CACHE BOOL "" FORCE)
set(LWS_WITH_STUB OFF CACHE BOOL "" FORCE)
# BASIC_AUTH must stay ON: it gates the client-side "Proxy-Authorization:
# basic" header (connect4.c), without which authenticated proxy URLs
# (http_proxy=http://user:pass@host:port) route through the proxy but never
# send credentials.
set(LWS_WITH_HTTP_BASIC_AUTH ON CACHE BOOL "" FORCE)
set(LWS_WITH_HTTP_DIGEST_AUTH OFF CACHE BOOL "" FORCE)
# GENCRYPTO must stay ON: lws compiles tls/lws-gencrypto-common.c (HKDF)
# unconditionally, which needs the genhmac API.
set(LWS_WITH_GENCRYPTO ON CACHE BOOL "" FORCE)
# Note: LWS_WITH_HTTP_UNCOMMON_HEADERS must stay ON: it selects the full
# pre-generated header lexer table; without it headers like
# Transfer-Encoding are not parsed and requests fail with 400.
set(LWS_WITH_JPEG OFF CACHE BOOL "" FORCE)
set(LWS_WITH_GZINFLATE OFF CACHE BOOL "" FORCE)
# Note: LWS_WITH_FILE_OPS must stay ON: lws_create_adopt_udp2 (async DNS)
# needs lws_plat_apply_FD_CLOEXEC from plat/unix/unix-file.c.
set(LWS_WITH_LIBCAP OFF CACHE BOOL "" FORCE)
set(LWS_WITH_BINDTODEVICE OFF CACHE BOOL "" FORCE)
set(LWS_SSL_CLIENT_USE_OS_CA_CERTS OFF CACHE BOOL "" FORCE)
set(LWS_WITH_LIBUV OFF CACHE BOOL "" FORCE)
if(BUILD_WITH_TLS)
    set(LWS_WITH_MBEDTLS ON CACHE BOOL "" FORCE)
    set(LWS_WITH_SSL ON CACHE BOOL "" FORCE)
else()
    set(LWS_WITH_MBEDTLS OFF CACHE BOOL "" FORCE)
    set(LWS_WITH_SSL OFF CACHE BOOL "" FORCE)
endif()
set(LWS_WITHOUT_EXTENSIONS ON CACHE BOOL "" FORCE)
set(LWS_WITHOUT_TESTAPPS ON CACHE BOOL "" FORCE)
set(LWS_WITH_SHARED OFF CACHE BOOL "" FORCE)
set(LWS_WITH_STATIC ON CACHE BOOL "" FORCE)
set(LWS_MSVC_STATIC_RUNTIME ON CACHE BOOL "" FORCE)
set(LWS_WITH_MINIMAL_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LWS_WITH_TLS_SESSIONS OFF CACHE BOOL "" FORCE)
set(LWS_WITH_EXPORT_LWSTARGETS OFF CACHE BOOL "" FORCE)
set(LWS_WITH_NETLINK OFF CACHE BOOL "" FORCE)
# lws's own async DNS resolver discovers nameservers from /etc/resolv.conf
# (generic unix plat) or the net.dnsN system properties (LWS_PLAT_ANDROID).
if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    set(LWS_WITH_SYS_ASYNC_DNS OFF CACHE BOOL "" FORCE)
else()
    set(LWS_WITH_SYS_ASYNC_DNS ON CACHE BOOL "" FORCE)
endif()
set(LWS_WITH_SOCKS5 ON CACHE BOOL "" FORCE)
# Our custom event lib (src/lws-evlib.c, event_lib_custom) is a full event-lib
# integration, not lws's built-in poll() loop. LWS_WITH_EVENT_LIBS makes lws
# route every fd/wsi lifecycle event through the event-lib ops — including the
# client connection-pool socket handoff in
# _lws_generic_transaction_completed_active_conn (guarded by this define), which
# is what fetch keep-alive/pipelining relies on to migrate a warm connection to
# the next request. It also disables lws's default-poll() foreign-thread pollfd
# bookkeeping, which is dead code for a custom event lib. Our ops report
# evlib_size_{wsi,vh,ctx} == 0 (watchers live in a wsi-keyed hash map), so no
# per-object evlib storage is expected. LWS_WITH_EVLIB_PLUGINS stays OFF: we
# link one static custom evlib, not runtime-loaded plugins.
set(LWS_WITH_EVENT_LIBS ON CACHE BOOL "" FORCE)
set(LWS_WITH_EVLIB_PLUGINS OFF CACHE BOOL "" FORCE)
set(LWS_WITH_CACHE_NSCOOKIEJAR ON CACHE BOOL "" FORCE)
# Tell lws about mbedtls capabilities (CHECK_FUNCTION_EXISTS fails for static libs)
set(LWS_HAVE_mbedtls_md_setup 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_conf_ciphersuites 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_rsa_complete 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_net_init 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_conf_alpn_protocols 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_get_alpn_protocol 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_conf_sni 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_set_hs_ca_chain 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_set_hs_own_cert 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_set_hs_authmode 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_x509_crt_parse_file 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_internal_aes_encrypt 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_MBEDTLS_NET_SOCKETS 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_MBEDTLS_SSL_NEW_SESSION_TICKET 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_set_quic_transport_ops 1 CACHE BOOL "" FORCE)
set(LWS_HAVE_mbedtls_ssl_set_export_keys_cb 1 CACHE BOOL "" FORCE)
set(LWS_MBEDTLS_LIBRARIES mbedtls mbedx509 mbedcrypto CACHE STRING "" FORCE)
set(LWS_MBEDTLS_INCLUDE_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/deps/mbedtls/include" CACHE STRING "" FORCE)
add_subdirectory(deps/libwebsockets EXCLUDE_FROM_ALL)
# Work around mbedtls ssl.h using #if instead of #ifdef on
# MBEDTLS_SSL_DTLS_CONNECTION_ID_COMPAT (undefined when DTLS is disabled).
if(NOT MSVC)
    target_compile_options(websockets PRIVATE -Wno-undef)
endif()
if(CMAKE_C_COMPILER_ID MATCHES "GNU")
    target_compile_options(websockets PRIVATE -Wno-discarded-qualifiers)
endif()
target_link_libraries(tjs PUBLIC websockets)
target_include_directories(tjs PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/deps/libwebsockets/include)

