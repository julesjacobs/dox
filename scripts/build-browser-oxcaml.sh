#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
oxcaml_root="$repo_root/vendor/oxcaml"
experiment="$oxcaml_root/experiments/web_bytecode"
opam_root="$oxcaml_root/.opam-oxweb-root"
opam_switch="oxweb"
compiler_bin="$experiment/toolchain/bytecode-bin"
build="$oxcaml_root/_build/default/experiments/web_bytecode"
assets="$repo_root/web/oxcaml"

if [ ! -x "$oxcaml_root/_install/bin/ocamlc" ]; then
  printf '%s\n' \
    "The browser compiler needs an installed vendor/oxcaml compiler." \
    "Run 'make install' in vendor/oxcaml, then rerun this script." >&2
  exit 1
fi

if [ ! -x "$opam_root/$opam_switch/bin/js_of_ocaml" ]; then
  "$experiment/ensure_oxweb_switch.sh"
fi

env \
  OCAMLFIND_CONF="$opam_root/$opam_switch/lib/findlib.conf" \
  OCAMLPATH= \
  JS_OF_OCAML_BIN="$opam_root/$opam_switch/bin/js_of_ocaml" \
  OXBROWSER_OPAM_ROOT="$opam_root" \
  OXBROWSER_OPAM_SWITCH="$opam_switch" \
  OXBROWSER_DOX_MINIMAL=1 \
  OXBROWSER_COMPILER_BIN="$compiler_bin" \
  "$experiment/build_browser_switch.sh"

mkdir -p "$assets/build/browser_fs"
rsync -a --delete "$build/browser_fs/" "$assets/build/browser_fs/"
cp "$build/browser_fs_manifest.json" "$assets/build/browser_fs_manifest.json"
cp "$build/web_bytecode_js.bc.js" "$assets/build/web_bytecode_js.bc.js"
cp \
  "$experiment/backend.js" \
  "$experiment/backend_direct.js" \
  "$experiment/backend_worker.js" \
  "$experiment/playground_prelude.js" \
  "$experiment/runtime_shims.js" \
  "$assets/"

printf 'Updated browser OxCaml assets in %s\n' "$assets"
