#!/usr/bin/env bash
#
# append-changelog.sh — append a bullet under ## [Unreleased] / ### <Section>
# in CHANGELOG.md.
#
# Usage:
#   append-changelog.sh <changelog> <section> <user-facing> [<technical>]
#
# Section: Added | Changed | Fixed | Removed | Security  (no Skip — caller skips)
#
# Creates the ### <Section> subsection under ## [Unreleased] if it doesn't
# exist yet (preferred order: Added → Changed → Removed → Fixed → Security).
#
# Exit codes:
#   0  bullet appended
#   1  changelog missing / unwritable / [Unreleased] header missing / verify failed
#   2  malformed args (bad section, empty user-facing, style violation)
#
set -euo pipefail

CHANGELOG="${1:?Usage: append-changelog.sh <changelog> <section> <user-facing> [<technical>]}"
SECTION="${2:-}"
USER_FACING="${3:-}"
TECHNICAL="${4:-}"

[[ -f "$CHANGELOG" && -w "$CHANGELOG" ]] \
  || { echo "CHANGELOG missing or unwritable: $CHANGELOG" >&2; exit 1; }

case "$SECTION" in
  Added|Changed|Fixed|Removed|Security) ;;
  "")
    echo "Section is required" >&2; exit 2 ;;
  *)
    echo "Bad section: '$SECTION'. Expected Added|Changed|Fixed|Removed|Security" >&2
    exit 2
    ;;
esac

[[ -n "$USER_FACING" ]] || { echo "user-facing is empty" >&2; exit 2; }

# Style guard: ISS-NNN forbidden in user-facing copy
if grep -qE 'ISS-[0-9]+' <<<"$USER_FACING"; then
  echo "Style violation: user-facing contains ISS-NNN. Redraft via forge-clarify." >&2
  exit 2
fi

grep -q '^## \[Unreleased\]' "$CHANGELOG" \
  || { echo "## [Unreleased] header not found in $CHANGELOG" >&2; exit 1; }

# Compose bullet (single string with embedded newline if Technical present)
if [[ -n "$TECHNICAL" ]]; then
  BULLET=$(printf -- '- **%s**\n  *Technical: %s*' "$USER_FACING" "$TECHNICAL")
else
  BULLET=$(printf -- '- **%s**' "$USER_FACING")
fi

# Insert at END of ### <SECTION> inside ## [Unreleased].
# If ### <SECTION> doesn't exist, create it before the next ### or ## header.
SECTION_ORDER="Added Changed Removed Fixed Security"

awk -v section="$SECTION" -v bullet="$BULLET" -v order="$SECTION_ORDER" '
  BEGIN { found_section = 0 }
  /^## \[Unreleased\]/ {
    in_unrel = 1
    print
    next
  }
  /^## \[/ && !/^## \[Unreleased\]/ {
    # leaving [Unreleased] — flush pending bullet first
    if (in_sec) {
      print bullet
      print ""
    }
    if (in_unrel && !found_section) {
      print "### " section
      print ""
      print bullet
      print ""
    }
    in_unrel = 0
    in_sec = 0
  }
  in_unrel && $0 == "### " section {
    found_section = 1
    in_sec = 1
    print
    next
  }
  in_sec && /^### / {
    # leaving our section — emit bullet first
    print bullet
    print ""
    in_sec = 0
  }
  { print }
  END {
    if (in_sec) print bullet
    else if (in_unrel && !found_section) {
      print "### " section
      print ""
      print bullet
    }
  }
' "$CHANGELOG" > "$CHANGELOG.tmp" && mv "$CHANGELOG.tmp" "$CHANGELOG"

# Verify insertion landed
BULLET_HEAD=$(head -1 <<<"$BULLET")
if ! grep -Fq -- "$BULLET_HEAD" "$CHANGELOG"; then
  echo "Insertion failed — bullet not present after rewrite." >&2
  exit 1
fi

echo "appended: $SECTION — $USER_FACING"
