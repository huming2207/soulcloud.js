#!/usr/bin/env bash
# Scans the web frontend for hardcoded CJK strings outside the i18n
# dictionary (Kimi audit finding: multi-language OR assertions could not
# catch hardcoded Han; this is the static guard).
#
# Usage: bash scripts/scan-hardcoded-i18n.sh
# Exit 1 with a file:line list when any CJK characters are found in
# non-test, non-i18n source files. Zero output + exit 0 = clean.
set -euo pipefail
cd "$(dirname "$0")/.."

HITS=$(python3 - <<'EOF'
import pathlib, re, sys
root = pathlib.Path("packages/web/src")
skip_dir = ("i18n",)
skip_name = (".test.",)
pat = re.compile(r"[\u4e00-\u9fff]")
hits = []
for f in sorted(root.rglob("*")):
    if not f.is_file():
        continue
    if f.suffix not in (".ts", ".tsx"):
        continue
    if any(part in skip_dir for part in f.parts):
        continue
    if any(s in f.name for s in skip_name):
        continue
    for i, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
        # strip line comments before matching (comments may quote CJK)
        code = line.split("//", 1)[0]
        if pat.search(code):
            hits.append(f"{f}:{i}: {line.strip()[:100]}")
print("\n".join(hits))
EOF
)

if [ -n "$HITS" ]; then
  echo "hardcoded CJK strings found (use the i18n dictionary instead):"
  echo "$HITS"
  exit 1
fi
echo "no hardcoded CJK strings outside the i18n dictionary"
