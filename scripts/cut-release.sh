#!/usr/bin/env bash
# Cuts the CLOUD release: bumps the version files in lockstep, folds the
# changelog.d/ fragments into a new CHANGELOG.md version section and deletes
# them, commits, tags and pushes.
#
# Two lines, told apart by the version alone. X.Y.Z and X.Y.Z-rc.N are cut on
# main and tagged vX.Y.Z here. X.Y.Z-dev.N is a dev release: cut on dev, its
# number the one the forge project's Forge release allocated (project document
# `release.prerelease`), and NOT tagged here — dev-vX.Y.Z-dev.N goes on the
# commit only once forge-dev serves it (docs/adr/0002), so main's v* namespace
# never sees a dev release and no tag names a build nobody served.
#
# The runner is NOT cloud. It sits at 0.9.x against cloud's 0.3.x and is cut with
# `runner-vX.Y.Z` by its own workflow; bumping the two together walks it backwards.
#
# Refused RELEASE_SUITE_NOT_GREEN unless the commit it cuts from has a green whole-suite run (step
# 1b); `gh` must be able to read the repository's check runs for that.
#
# Usage: scripts/cut-release.sh X.Y.Z[-rc.N|-dev.N] --headline "plain-language summary" [--no-push]
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
FRAGMENTS=changelog.d

die() { printf '\ncut-release: %s\n' "$*" >&2; exit 1; }

NEW=''; HEADLINE=''; PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --headline) [ $# -ge 2 ] || die "--headline needs a value"; HEADLINE="$2"; shift 2;;
    --no-push)  PUSH=0; shift;;
    -h|--help)  sed -n '1,19p' "$0"; exit 0;;
    -*)         die "unknown flag $1";;
    *)          [ -z "$NEW" ] || die "version given twice ($NEW, then $1)"; NEW="$1"; shift;;
  esac
done

# ---- step 0: preflight ----------------------------------------------------
# Every check below refuses by name. None of them is repaired here: a cut that
# tidies its own preconditions is a cut nobody can reconstruct afterwards.
[ -n "$NEW" ] || die "no version. Usage: scripts/cut-release.sh X.Y.Z --headline \"...\" [--no-push]"
[ -n "$HEADLINE" ] || die "--headline is mandatory: it opens the version section and the in-app What's New feed renders it for every signed-in user"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+|-dev\.[0-9]+)?$ ]] || die "version '$NEW' is not X.Y.Z, X.Y.Z-rc.N or X.Y.Z-dev.N"
if [[ "$NEW" == *-dev.* ]]; then RELEASE_BRANCH=dev; TAG="dev-v$NEW"; else RELEASE_BRANCH=main; TAG="v$NEW"; fi

# The headline opens the section and the What's New feed renders it to every signed-in user,
# above every bullet. It is the one line most readers see, so it is the one line held tightest.
HEADLINE_BUDGET=15
HEADLINE_WORDS=$(wc -w <<<"$HEADLINE")
[ "$HEADLINE_WORDS" -le "$HEADLINE_BUDGET" ] || die "--headline is $HEADLINE_WORDS words, budget is $HEADLINE_BUDGET.
It is the line the What's New feed shows above everything else in the release; say what this
release is for, not what is in it \u2014 the bullets carry that."


cd "$(git rev-parse --show-toplevel)"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "$RELEASE_BRANCH" ] || die "on branch '$BRANCH', and $NEW is cut on $RELEASE_BRANCH"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean — commit or stash first:
$(git status --short | head -10)"
git fetch -q origin "$RELEASE_BRANCH"
LOCAL=$(git rev-parse "$RELEASE_BRANCH"); REMOTE=$(git rev-parse "origin/$RELEASE_BRANCH")
[ "$LOCAL" = "$REMOTE" ] || die "$RELEASE_BRANCH ($(git rev-parse --short "$RELEASE_BRANCH")) is not in sync with origin/$RELEASE_BRANCH ($(git rev-parse --short "origin/$RELEASE_BRANCH"))"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
[ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || die "tag $TAG already exists on origin"
for f in "${VERSION_JSON_FILES[@]}"; do [ -f "$f" ] || die "version file missing: $f"; done
[ -f "$RECORD" ] || die "$RECORD is missing"

# ---- step 1: the section must have something in it ------------------------
# A version section with no bullets is a release that says nothing shipped, and
# the What's New feed renders it as an empty card.
# Every file there but its README.md is a fragment; a malformed one is refused by the writer below.
FRAGMENT_FILES=()
for f in "$FRAGMENTS"/*; do
  if [ -f "$f" ] && [ "$f" != "$FRAGMENTS/README.md" ]; then FRAGMENT_FILES+=("$f"); fi
done
BULLETS=${#FRAGMENT_FILES[@]}
[ "$BULLETS" -gt 0 ] || die "no fragments under $FRAGMENTS/ — nothing to release"
grep -q '^## \[Unreleased\]' "$RECORD" && die "$RECORD still carries \`## [Unreleased]\`; move its entries to $FRAGMENTS/<name>.<section>.md and delete the heading"

# ---- step 1b: the whole suite is green on the commit this cut ships -------
# REQ-36 BC-10: a release is cut only on a commit whose whole-suite run is green, read from the
# `whole-suite` check run CI left on it (scripts/whole-suite.mjs). With none there and none in
# flight, it starts one on this branch's head, which is this commit, and refuses; the cut is taken
# again once that run is green. It runs after every other refusal above so a cut refused for
# something else starts nothing. A read that fails refuses too: a gate that cannot read never passes.
SUITE=$(node scripts/whole-suite.mjs gate --commit "$LOCAL" --branch "$RELEASE_BRANCH" --dispatch 2>&1) || die "$SUITE"
printf '%s\n' "$SUITE"

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

# ---- step 3: write the section ---------------------------------------------
# Each fragment becomes one bullet under its `###` section and is deleted, so the
# release commit is the one place an entry moves from $FRAGMENTS/ to $RECORD.
DATE=$(date -u +%F)
node scripts/lib/assemble-release.mjs "$RECORD" "$FRAGMENTS" "$NEW" "$DATE" "$HEADLINE" >/dev/null || die "could not write [$NEW] into $RECORD from $FRAGMENTS/"

# ---- step 4: commit and tag -----------------------------------------------
git add -- "${VERSION_JSON_FILES[@]}" "$RECORD" "${FRAGMENT_FILES[@]}"
git commit -q -m "Release $TAG" -m "$HEADLINE"
if [ "$RELEASE_BRANCH" = main ]; then
  git tag "$TAG"
  [ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)" ] || die "tag $TAG does not point at HEAD"
fi

# ---- step 5: push ---------------------------------------------------------
if [ "$PUSH" -eq 1 ]; then
  git push -q origin "$RELEASE_BRANCH"
  [ "$RELEASE_BRANCH" = dev ] || git push -q origin "$TAG"
  PUSHED="pushed to origin"
else
  PUSHED="NOT pushed — run: git push origin $RELEASE_BRANCH$([ "$RELEASE_BRANCH" = dev ] || printf ' && git push origin %s' "$TAG")"
fi
if [ "$RELEASE_BRANCH" = dev ]; then
  DEPLOYS="Not tagged yet. Deploy this commit through the Forge release that cut $NEW;
  once https://forge-dev-api.sidcorp.co/api/version serves $(git rev-parse HEAD):
    git tag $TAG $(git rev-parse HEAD) && git push origin $TAG"
else
  DEPLOYS="No workflow builds from this tag. core and web reach forge-beta through their
  own Coolify deploy, which this script does not trigger."
fi

# ---- step 6: say what happened --------------------------------------------
cat <<EOF

  cut $TAG  ($(git rev-parse --short HEAD))
  $BULLETS fragment(s) written into [$NEW] - $DATE and deleted
  $(printf '%s' "${#VERSION_JSON_FILES[@]}") version file(s) at $NEW
  $PUSHED

  $DEPLOYS
EOF
