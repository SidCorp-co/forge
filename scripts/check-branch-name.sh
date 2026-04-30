#!/bin/bash
# Branch name validator — see docs/decisions/0014-trunk-based-development.md
#
# Two accepted schemes:
#   1. Maintainer / Forge pipeline:
#        ISS-<seq>-<slug>
#        ISS-<seq>-chunk-<a-z>-<slug>
#   2. External contributor (GitHub-native):
#        feat/<slug>
#        fix/<slug>
#        fix/gh-<num>-<slug>
#        docs/<slug>
#        chore/<slug>
#        refactor/<slug>
#        test/<slug>
#        perf/<slug>
#
# Slug rules: lowercase a-z 0-9, kebab-case (hyphen separator), 2-50 chars.
# Total branch name ≤ 60 chars.
#
# Exit 0: branch name OK (or branch is an exempt name like main).
# Exit 1: branch name violates rules.
#
# Usage:
#   scripts/check-branch-name.sh                  # validates current branch
#   scripts/check-branch-name.sh <branch-name>    # validates a specific name

set -e

branch="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"

if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  echo "[check-branch] no branch detected (detached HEAD?) — skipping"
  exit 0
fi

# Exempt: trunk + special refs that don't go through the pipeline
case "$branch" in
  main|master|HEAD)
    exit 0
    ;;
esac

# Hard length cap — most platforms truncate near 60. Refs over 50 stay readable.
length=${#branch}
if [ "$length" -gt 60 ]; then
  echo "[check-branch] FAIL: branch '$branch' is ${length} chars (max 60)"
  exit 1
fi

# Reject obvious smell: spaces, uppercase outside the ISS prefix, double slashes.
if echo "$branch" | grep -qE '[[:space:]]'; then
  echo "[check-branch] FAIL: branch '$branch' contains whitespace"
  exit 1
fi
if echo "$branch" | grep -qE '_'; then
  echo "[check-branch] FAIL: branch '$branch' contains underscore — use hyphens"
  exit 1
fi
if echo "$branch" | grep -qE '/{2,}'; then
  echo "[check-branch] FAIL: branch '$branch' has consecutive slashes"
  exit 1
fi

# Common smells checked BEFORE pattern match — the main regex would
# accidentally accept `ISS-261-262-rc6` (slug `262-rc6` is technically valid)
# without these guards.
if echo "$branch" | grep -qE '^ISS-[0-9]+-[0-9]+'; then
  echo "[check-branch] FAIL: '$branch' looks like a multi-issue branch (ISS-A-B-…)."
  echo "[check-branch]       Split into one branch per issue. See ADR 0014."
  exit 1
fi
if echo "$branch" | grep -qE '^ISS-[a-z]'; then
  echo "[check-branch] FAIL: '$branch' has no issue sequence number."
  echo "[check-branch]       Use ISS-<seq>-<slug>, e.g. ISS-279-job-handler."
  exit 1
fi
if echo "$branch" | grep -qE '[A-Z]'; then
  # ISS prefix is capital but everything else must be lowercase. Anchor on the
  # first non-ISS uppercase letter for a useful error.
  if ! echo "$branch" | grep -qE '^ISS-'; then
    echo "[check-branch] FAIL: branch '$branch' has uppercase — kebab-case lowercase only."
    exit 1
  fi
  if echo "$branch" | grep -qE '^ISS-[0-9]+(-chunk-[a-z])?-.*[A-Z]'; then
    echo "[check-branch] FAIL: branch '$branch' has uppercase in the slug — kebab-case lowercase only."
    exit 1
  fi
fi

# Pattern definitions. Anchored. Slug = [a-z0-9]+(-[a-z0-9]+)*.
SLUG='[a-z0-9]+(-[a-z0-9]+)*'

# 1) Maintainer pipeline scheme
ISS_RX="^ISS-[0-9]+(-chunk-[a-z])?-${SLUG}$"

# 2) External contributor scheme
TYPE_RX="^(feat|fix|docs|chore|refactor|test|perf)/(gh-[0-9]+-)?${SLUG}$"

if echo "$branch" | grep -qE "$ISS_RX"; then
  exit 0
fi

if echo "$branch" | grep -qE "$TYPE_RX"; then
  exit 0
fi

# Catch-all
cat <<EOF >&2
[check-branch] FAIL: branch '$branch' does not match any accepted pattern.

Accepted forms:
  ISS-<seq>-<slug>                    (maintainer / Forge pipeline)
  ISS-<seq>-chunk-<a-z>-<slug>        (epic split)
  feat/<slug>                         (external contributor)
  fix/<slug>
  fix/gh-<num>-<slug>                 (link a GitHub issue)
  docs/<slug>  chore/<slug>  refactor/<slug>  test/<slug>  perf/<slug>

Rules:
  - <slug> is kebab-case lowercase (a-z, 0-9, hyphen), 2-50 chars
  - Total branch name ≤ 60 chars
  - One issue per branch (no ISS-A-B-…)

Override: rename the branch to match an accepted pattern.

See docs/decisions/0014-trunk-based-development.md.
EOF
exit 1
