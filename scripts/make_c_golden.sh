#!/bin/sh
# C のプリセットとテスト用プログラムを手元の C コンパイラ（cc）で動かし、出力を tests/c_golden.json に書く
# 使い方：sh scripts/make_c_golden.sh
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
out=tests/c_golden.json
echo '{' > "$out"
first=1
add() {
  name=$1; shift
  cc -w -o "$tmp/a.out" "$@"
  res=$("$tmp/a.out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read(), ensure_ascii=False))')
  [ $first = 1 ] || echo ',' >> "$out"
  first=0
  printf '  "%s": %s' "$name" "$res" >> "$out"
}
for d in presets/c/*/; do add "preset:$(basename "$d")" "$d"*.c; done
for f in tests/c/*.c; do add "test:$(basename "$f" .c)" "$f"; done
printf '\n}\n' >> "$out"
rm -rf "$tmp"
cat "$out"
