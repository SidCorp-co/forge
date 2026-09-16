#!/usr/bin/env bash
# Cuts the CLOUD release: bumps the version files in lockstep, promotes the
# changelog's `[Unreleased]` section, commits, tags and pushes.
#
# The runner is NOT cloud. It sits at 0.9.x against cloud's 0.3.x and is cut with
# `runner-vX.Y.Z` by its own workflow; bumping the two together walks it backwards.
#
# Usage: scripts/cut-release.sh X.Y.Z --headline "plain-language summary" [--no-push]
set -euo pipefail

# The file list lives here and nowhere else. A new cloud package is one line.
VERSION_JSON_FILES=(
  package.json
  packages/core/package.json
  packages/contracts/package.json
  packages/observability/package.json
  packages/web-v2/package.json
)

RECORD=CHANGELOG.md
UNRELEASED='## [Unreleased]'

die() { printf '\ncut-release: %s\n' "$*" >&2; exit 1; }

NEW=''; HEADLINE=''; PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --headline) [ $# -ge 2 ] || die "--headline needs a value"; HEADLINE="$2"; shift 2;;
    --no-push)  PUSH=0; shift;;
    -h|--help)  sed -n '1,8p' "$0"; exit 0;;
    -*)         die "unknown flag $1";;
    *)          [ -z "$NEW" ] || die "version given twice ($NEW, then $1)"; NEW="$1"; shift;;
  esac
done

# ---- step 0: preflight ----------------------------------------------------
# Every check below refuses by name. None of them is repaired here: a cut that
# tidies its own preconditions is a cut nobody can reconstruct afterwards.
[ -n "$NEW" ] || die "no version. Usage: scripts/cut-release.sh X.Y.Z --headline \"...\" [--no-push]"
[ -n "$HEADLINE" ] || die "--headline is mandatory: it opens the version section and the in-app What's New feed renders it for every signed-in user"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || die "version '$NEW' is not X.Y.Z or X.Y.Z-rc.N"

# The headline opens the section and the What's New feed renders it to every signed-in user,
# above every bullet. It is the one line most readers see, so it is the one line held tightest.
HEADLINE_BUDGET=15
HEADLINE_WORDS=$(wc -w <<<"$HEADLINE")
[ "$HEADLINE_WORDS" -le "$HEADLINE_BUDGET" ] || die "--headline is $HEADLINE_WORDS words, budget is $HEADLINE_BUDGET.
It is the line the What's New feed shows above everything else in the release; say what this
release is for, not what is in it \u2014 the bullets carry that."


cd "$(git rev-parse --show-toplevel)"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] || die "on branch '$BRANCH', not main"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean — commit or stash first:
$(git status --short | head -10)"
git fetch -q origin main
LOCAL=$(git rev-parse main); REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] || die "main ($(git rev-parse --short main)) is not in sync with origin/main ($(git rev-parse --short origin/main))"
TAG="v$NEW"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
[ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || die "tag $TAG already exists on origin"
for f in "${VERSION_JSON_FILES[@]}"; do [ -f "$f" ] || die "version file missing: $f"; done
[ -f "$RECORD" ] || die "$RECORD is missing"

# ---- step 1: the section must have something in it ------------------------
# A version section with no bullets is a release that says nothing shipped, and
# the What's New feed renders it as an empty card.
UNREL_BODY=$(awk -v h="$UNRELEASED" '
  $0 == h {inside=1; next}
  /^## / {inside=0}
  inside {print}' "$RECORD")
grep -q '^[-*+] ' <<<"$UNREL_BODY" || die "$RECORD has no bullets under \`$UNRELEASED\` — nothing to promote"
BULLETS=$(grep -c '^[-*+] ' <<<"$UNREL_BODY")

# ---- step 2: atomic version bump ------------------------------------------
# Written to a staging directory and verified to agree BEFORE anything moves, so
# a failure half-way leaves five files at the old version rather than three at
# the new one — a split the next reader cannot tell from a deliberate state.
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
for f in "${VERSION_JSON_FILES[@]}"; do
  mkdir -p "$STAGE/$(dirname "$f")"
  jq --arg v "$NEW" '.version = $v' "$f" > "$STAGE/$f" || die "jq failed rewriting $f"
  [ -s "$STAGE/$f" ] || die "staged $f came out empty"
done
SEEN=$(for f in "${VERSION_JSON_FILES[@]}"; do jq -r .version "$STAGE/$f"; done | sort -u)
[ "$(wc -l <<<"$SEEN")" -eq 1 ] && [ "$SEEN" = "$NEW" ] || die "staged files disagree about the version: $(tr '\n' ' ' <<<"$SEEN")"
for f in "${VERSION_JSON_FILES[@]}"; do mv "$STAGE/$f" "$f"; done

# ---- step 3: promote the section ------------------------------------------
# The new `[Unreleased]` is flat on purpose: `###` headings belong to a cut
# section, and check-release-record fails a heading repeated inside one.
DATE=$(date -u +%F)
python3 - "$RECORD" "$NEW" "$DATE" "$HEADLINE" <<'PY'
import sys
path, ver, date, headline = sys.argv[1:5]
src = open(path, encoding='utf-8').read()
marker = '## [Unreleased]'
i = src.index(marker)
after = src[i + len(marker):]
new = (f'{marker}\n\n## [{ver}] - {date}\n\n{headline}\n' + after)
open(path, 'w', encoding='utf-8').write(src[:i] + new)
PY

# ---- step 4: commit and tag -----------------------------------------------
git add -- "${VERSION_JSON_FILES[@]}" "$RECORD"
git commit -q -m "Release $TAG" -m "$HEADLINE"
git tag "$TAG"
[ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)" ] || die "tag $TAG does not point at HEAD"

# ---- step 5: push ---------------------------------------------------------
if [ "$PUSH" -eq 1 ]; then
  git push -q origin main
  git push -q origin "$TAG"
  PUSHED="pushed to origin"
else
  PUSHED="NOT pushed — run: git push origin main && git push origin $TAG"
fi

# ---- step 6: say what happened --------------------------------------------
cat <<EOF

  cut $TAG  ($(git rev-parse --short HEAD))
  $BULLETS bullet(s) promoted into [$NEW] - $DATE
  $(printf '%s' "${#VERSION_JSON_FILES[@]}") version file(s) at $NEW
  $PUSHED

  No workflow builds from this tag. core and web reach forge-beta through their
  own Coolify deploy, which this script does not trigger.
EOF
