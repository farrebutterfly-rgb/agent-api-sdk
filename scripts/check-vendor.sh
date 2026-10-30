#!/usr/bin/env bash
# Verify that vendor/<repo>/ files are byte-identical to the commit recorded in its VENDORED.md.
# The sibling repos are optional: when ../<repo> is missing the check is skipped, not failed,
# so a clean checkout of this repo alone still passes.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
for dir in vendor/*/; do
  name=$(basename "$dir")
  manifest="$dir/VENDORED.md"
  commit=$(grep -m1 -oE '[0-9a-f]{40}' "$manifest")
  files=$(awk '/^## Files/{f=1;next} f&&/^```/{c++;next} f&&c==1{print}' "$manifest")
  src="../$name"
  if [ ! -d "$src/.git" ]; then
    echo "skip   $name: sibling repo $src not found (nothing to compare against)"
    continue
  fi
  if ! git -C "$src" cat-file -e "$commit^{commit}" 2>/dev/null; then
    echo "FAIL   $name: commit $commit not in $src"; status=1; continue
  fi
  n=0; bad=0
  for f in $files; do
    n=$((n+1))
    if ! git -C "$src" show "$commit:$f" | cmp -s - "$dir$f"; then echo "FAIL   $name: $f differs from $commit"; bad=$((bad+1)); fi
  done
  listed=$(echo "$files" | sort); actual=$(cd "$dir" && find . -type f -not -name VENDORED.md -not -path '*__pycache__*' | sed 's|^\./||' | sort)
  if [ "$listed" != "$actual" ]; then echo "FAIL   $name: files on disk do not match the list in VENDORED.md"; bad=$((bad+1)); fi
  head=$(git -C "$src" rev-parse HEAD)
  note=""; [ "$head" != "$commit" ] && note=" (sibling HEAD is now ${head:0:7}; re-vendor deliberately if you want its changes)"
  if [ $bad -eq 0 ]; then echo "ok     $name: $n files match ${commit:0:7}$note"; else status=1; fi
done
exit $status
