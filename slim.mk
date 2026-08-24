# Fork-only additions to the bundle pipeline (lukasMega/txiki.js-with-slim-builds).
#
# Everything this fork adds to `make js` lives here, so the delta in the
# upstream-owned Makefile is a single `-include slim.mk` line. `-include` (not
# `include`) keeps the Makefile working if this file is ever absent.
#
# The two esbuild overrides below are GNU-make *target-specific* variables:
# they extend ESBUILD_PARAMS_COMMON only while building that one bundle, so
# upstream's recipes stay byte-identical. Do not append the flags globally --
# --minify-syntax would then also apply to core/run-repl/stdlib and change
# their committed bytecode.

# Optional bytecode compression: pass -z to tjsc so embedded bytecode is
# deflated with miniz. Empty by default (no compression). The build:smallest*
# tasks set TJSC_COMPRESS=-z together with -DBUILD_WITH_COMPRESSED_BYTECODE=ON.
# Threaded through every tjsc rule via TJSC_PARAMS_STIP.
TJSC_COMPRESS?=

# Re-stated rather than appended to: upstream sets TJSC_PARAMS_STIP in both
# branches of its JS_NO_STRIP conditional, and this file is included after it.
ifeq ($(JS_NO_STRIP),1)
	TJSC_PARAMS_STIP=$(TJSC_COMPRESS)
else
	TJSC_PARAMS_STIP=-s $(TJSC_COMPRESS)
endif

# CLI subcommand/option gating for the run-main bundle. All default to true
# (full CLI). The untracked slim.sh wrapper overrides this on the command line
# (make RUN_MAIN_DEFINES="...") to compile commands out via esbuild dead-code
# elimination. See .claude/plans/2026-06-17_cli-command-removal.md.
#
# __TJS_REPL__ is the one entry here with a C half: it must be paired with
# -DBUILD_WITH_REPL=OFF, which drops run-repl.c and core.runRepl. Setting only
# this one leaves ~80 KB of unreachable REPL bytecode in the binary; setting
# only the CMake one leaves JS calling a function that no longer exists.
RUN_MAIN_DEFINES ?= \
	--define:__TJS_REPL__=true \
	--define:__TJS_EVAL__=true \
	--define:__TJS_SERVE__=true \
	--define:__TJS_BUNDLER__=true \
	--define:__TJS_TEST_RUNNER__=true \
	--define:__TJS_COMPILE__=true \
	--define:__TJS_APP__=true \
	--define:__TJS_HELP__=true \
	--define:__TJS_TLS_CA__=true

# Same dead-code-elimination pattern as RUN_MAIN_DEFINES, applied to the
# polyfills bundle. All default to true (full build unchanged). See
# .claude/plans/2026-06-18_binary-size-reduction-3.md (lever L5).
#
# NOTE: a __TJS_URLPATTERN__ define was tried and dropped -- the
# urlpattern-polyfill npm package's default entry point has an unconditional
# top-level side effect (auto-installs onto globalThis) and its package.json
# doesn't declare "sideEffects": false, so esbuild's tree-shaking treats it as
# unremovable regardless of whether the binding is used. Measured saving was
# ~70 bytes (noise) vs. the ~4.8 KB for XHR below, not worth the complexity.
POLYFILLS_DEFINES ?= \
	--define:__TJS_XHR__=true

# --minify-syntax is what performs the dead-code elimination on the defines
# above; it is spelled out because ESBUILD_PARAMS_MINIFY (which implies it) is
# emptied by JS_NO_STRIP=1.
src/bundles/js/core/run-main.js: ESBUILD_PARAMS_COMMON += --minify-syntax $(RUN_MAIN_DEFINES)
src/bundles/js/core/polyfills.js: ESBUILD_PARAMS_COMMON += --minify-syntax $(POLYFILLS_DEFINES)
