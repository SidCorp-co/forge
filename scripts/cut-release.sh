#!/usr/bin/env bash
# Cuts the CLOUD release: bumps the version files in lockstep, folds the
# changelog.d/ fragments into a new CHANGELOG.md version section and deletes
# them, commits, tags and pushes. The commit that ships folds every fragment it
# carries: where the branch moved while the cut ran, the merge onto it folds
# what landed meanwhile into the same version (step 4b), and a commit that would
# still ship a fragment is refused RELEASE_FRAGMENT_UNFOLDED, naming each (step 4c).
#
# Two lines, told apart by the version alone. X.Y.Z and X.Y.Z-rc.N are cut on
# main and tagged vX.Y.Z here. X.Y.Z-dev.N is a dev release: cut on dev, its
# number the one the forge project's Forge release allocated (project document
# `release.prerelease`), and NOT tagged here — dev-vX.Y.Z-dev.N goes on the
# commit only once forge-dev serves it (docs/adr/0002), so main's v* namespace
# never sees a dev release and no tag names a build nobody served.
#
# A dev release is a snapshot, not a gate (owner, 2026-10-29): every push to dev
# already deploys forge-dev (.github/workflows/deploy-dev.yml) and the whole suite
# runs on dev nightly, so a -dev.N cut records what was served and folds the
# fragments; it reads no whole-suite run, starts none and waits on nothing.
#
# The runner is NOT cloud. It sits at 0.9.x against cloud's 0.3.x and is cut with
# `runner-vX.Y.Z` by its own workflow; bumping the two together walks it backwards.
#
# X.Y.Z and X.Y.Z-rc.N are refused RELEASE_SUITE_NOT_GREEN unless the commit they cut from has a
# green whole-suite run (step 1b); `gh` must be able to read the repository's check runs for that. With none there it starts one
# and waits for it (up to CUT_SUITE_WAIT_MINUTES, 40 by default), so a cut ends green or red rather
# than "come back later". --at <sha> cuts on an earlier commit of the branch whose run is already
# started, so a cut stopped while waiting goes on waiting on that run instead of starting one on a
# newer head. --no-push is a rehearsal: it reads the suite, starts nothing and pushes nothing.
#
# Usage: scripts/cut-release.sh X.Y.Z[-rc.N|-dev.N] --headline "plain-language summary" [--at <sha>] [--no-push]
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

NEW=''; HEADLINE=''; PUSH=1; AT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --headline) [ $# -ge 2 ] || die "--headline needs a value"; HEADLINE="$2"; shift 2;;
    --at)       [ $# -ge 2 ] || die "--at needs a commit"; AT="$2"; shift 2;;
    --no-push)  PUSH=0; shift;;
    -h|--help)  sed -n '1,31p' "$0"; exit 0;;
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
# The commit this cut ships: the branch's head, or with --at an earlier commit of it, which the
# checkout is moved to so every step below reads what that commit holds.
CUT="$REMOTE"
if [ -n "$AT" ]; then
  CUT=$(git rev-parse -q --verify "$AT^{commit}") || die "--at $AT names no commit"
  git merge-base --is-ancestor "$CUT" "$REMOTE" || die "--at $AT is not on origin/$RELEASE_BRANCH"
fi
[ "$LOCAL" = "$REMOTE" ] || [ "$LOCAL" = "$CUT" ] || die "$RELEASE_BRANCH ($(git rev-parse --short "$RELEASE_BRANCH")) is not in sync with origin/$RELEASE_BRANCH ($(git rev-parse --short "origin/$RELEASE_BRANCH"))"
[ "$LOCAL" = "$CUT" ] || git checkout -q -B "$RELEASE_BRANCH" "$CUT"
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
# main's lines only: a dev snapshot reads no suite (see the header) and goes straight to the fold.
# REQ-36 BC-10: a release is cut only on a commit whose whole-suite run is green, read from the
# `whole-suite` check run CI left on it (scripts/whole-suite.mjs). With none there and none in
# flight, it starts one on this branch's head, which is this commit, and waits for its answer; a red
# run with no job failed on its own steps is rerun once. It runs after every other refusal above so
# a cut refused for something else starts nothing. A read that fails refuses too: a gate that
# cannot read never passes. A rehearsal (--no-push) reads only.
if [ "$RELEASE_BRANCH" = main ]; then
  if [ "$PUSH" -eq 1 ]; then
    ACT=(--dispatch --wait "${CUT_SUITE_WAIT_MINUTES:-40}" --poll "${CUT_SUITE_POLL_SECONDS:-30}")
  else
    ACT=()
  fi
  SUITE=$(node scripts/whole-suite.mjs gate --commit "$CUT" --branch "$RELEASE_BRANCH" ${ACT[@]+"${ACT[@]}"} 2>&1) || die "$SUITE"
  printf '%s\n' "$SUITE"
  # what the branch did meanwhile is named after the wait it happened in
  DURING='while its whole suite ran'
  CUT_IS="the commit this cut was taken on, whose whole suite is green"
else
  printf 'dev snapshot: no whole-suite run is read or started; the nightly suite runs on dev.\n'
  DURING='while the cut ran'
  CUT_IS="the commit this cut was taken on"
fi

# ---- steps 2 and 3: the fold -----------------------------------------------
# fold bumps the version files and writes the [$NEW] section from every fragment the working tree
# holds, deleting them, so the commit it makes is the one place an entry moves from $FRAGMENTS/ to
# $RECORD. It runs on the cut commit here, and again in step 4b on the merge onto a branch that moved
# while the cut ran, which is the commit that ships. FOLDED is how many fragments it folded; a
# failure sets FOLD_ERROR and changes nothing.
# The version files are written to a staging directory and verified to agree BEFORE anything moves,
# so a failure half-way leaves five files at the old version rather than three at the new one — a
# split the next reader cannot tell from a deliberate state. They move only once the section is
# written, so a section refused leaves them as they were.
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
DATE=$(date -u +%F)
FOLDED=0; FOLD_ERROR=''
fold() {
  local f seen out
  for f in "${VERSION_JSON_FILES[@]}"; do
    mkdir -p "$STAGE/$(dirname "$f")"
    jq --arg v "$NEW" '.version = $v' "$f" > "$STAGE/$f" || { FOLD_ERROR="jq failed rewriting $f"; return 1; }
    [ -s "$STAGE/$f" ] || { FOLD_ERROR="staged $f came out empty"; return 1; }
  done
  seen=$(for f in "${VERSION_JSON_FILES[@]}"; do jq -r .version "$STAGE/$f"; done | sort -u)
  { [ "$(wc -l <<<"$seen")" -eq 1 ] && [ "$seen" = "$NEW" ]; } || { FOLD_ERROR="staged files disagree about the version: $(tr '\n' ' ' <<<"$seen")"; return 1; }
  out=$(node scripts/lib/assemble-release.mjs "$RECORD" "$FRAGMENTS" "$NEW" "$DATE" "$HEADLINE" 2>&1) || { FOLD_ERROR=${out//assemble-release: /}; return 1; }
  FOLDED=$out
  for f in "${VERSION_JSON_FILES[@]}"; do mv "$STAGE/$f" "$f"; done
}
fold || die "could not write [$NEW] into $RECORD from $FRAGMENTS/:
$FOLD_ERROR"

# ---- step 4: commit (main is tagged after step 4c) ------------------------
git add -A -- "${VERSION_JSON_FILES[@]}" "$RECORD" "$FRAGMENTS"
git commit -q -m "Release $TAG" -m "$HEADLINE"
RELEASE=$(git rev-parse HEAD)

# ---- step 4b: land on the branch as it now stands --------------------------
# The branch went on landing while the cut ran (on main, while its whole suite ran). The release
# commit stays on the commit it was cut on, and is merged onto the branch's head — the head first, so the branch's first-parent
# history stays its landings, which the bisect walks. That merge is the commit that ships, so it is
# folded itself: it takes the head's tree, whose fragments are the cut's as they stand now (edited or
# deleted since) plus every one landed meanwhile, bumps the version files there and folds all of them
# into [$NEW]. The release commit adds nothing else the merge could lose — its version files, $RECORD
# and $FRAGMENTS/ are each rewritten from the head here. A fragment that cannot be folded refuses the
# cut by name and nothing is pushed.
RODE=0
git fetch -q origin "$RELEASE_BRANCH"
TIP=$(git rev-parse "origin/$RELEASE_BRANCH")
if [ "$TIP" != "$CUT" ]; then
  git merge-base --is-ancestor "$CUT" "$TIP" || die "origin/$RELEASE_BRANCH no longer holds $(git rev-parse --short "$CUT"), the commit this cut was taken on. The release commit $(git rev-parse --short "$RELEASE") is local only; nothing was pushed."
  RODE=$(git rev-list --first-parent --count "$CUT..$TIP")
  git checkout -q -B "$RELEASE_BRANCH" "$TIP"
  git merge -q --no-ff --no-commit -s ours "$RELEASE" >/dev/null 2>&1 || die "release commit $(git rev-parse --short "$RELEASE") does not merge onto origin/$RELEASE_BRANCH ($(git rev-parse --short "$TIP")). Nothing was pushed; the release commit is $RELEASE."
  if ! fold; then
    git merge --abort
    die "RELEASE_FRAGMENT_UNFOLDED: $RELEASE_BRANCH landed $RODE commit(s) past $(git rev-parse --short "$CUT") $DURING, and the merge that would ship them cannot fold what they carry into [$NEW]:
$FOLD_ERROR
Nothing was pushed. $RELEASE_BRANCH is at origin/$RELEASE_BRANCH; the release commit is $RELEASE. Land the fix to each fragment, then cut again with --at $CUT."
  fi
  git add -A -- "${VERSION_JSON_FILES[@]}" "$RECORD" "$FRAGMENTS"
  git commit -q -m "Merge release $TAG into $RELEASE_BRANCH" -m "Folds into [$NEW] the $FOLDED fragment(s) this merge ships, $RODE landing(s) past $(git rev-parse --short "$CUT") included."
fi
LANDED=$(git rev-parse HEAD)

# ---- step 4c: the commit that ships carries no fragment it did not fold ----
# Whatever is still under $FRAGMENTS/ in the commit about to ship would ship now and be written
# under the next version by the next cut. Refused by name, each path, and nothing is pushed.
UNFOLDED=$(git ls-tree -r --name-only "$LANDED" -- "$FRAGMENTS/" | grep -vxF "$FRAGMENTS/README.md" || true)
if [ -n "$UNFOLDED" ]; then
  git checkout -q -B "$RELEASE_BRANCH" "$TIP"
  die "RELEASE_FRAGMENT_UNFOLDED: $(git rev-parse --short "$LANDED"), the commit this cut would ship, still carries what [$NEW] does not list:
$(sed 's/^/  /' <<<"$UNFOLDED")
A fragment is a file $FRAGMENTS/<name>.<section>.md, no folder. Nothing was pushed. $RELEASE_BRANCH is at origin/$RELEASE_BRANCH; the release commit is $RELEASE."
fi

# main's tag names the release commit. It is made only now, once nothing above can refuse the cut,
# so a refused cut leaves no local tag behind to refuse the next attempt by name.
if [ "$RELEASE_BRANCH" = main ]; then
  git tag "$TAG" "$RELEASE"
  [ "$(git rev-parse "$TAG^{commit}")" = "$RELEASE" ] || die "tag $TAG does not point at the release commit"
fi

# ---- step 5: push ---------------------------------------------------------
if [ "$PUSH" -eq 1 ]; then
  # The branch can land again between step 4b's fetch and this push, which is then refused as not a
  # fast-forward. That is a refusal like any other, named, with the way back: the checkout goes back
  # to the cut commit, so a cut --at it merges onto the head as it is then.
  if ! git push -q origin "$RELEASE_BRANCH"; then
    git checkout -q -B "$RELEASE_BRANCH" "$CUT"
    [ "$RELEASE_BRANCH" = dev ] || git tag -d "$TAG" >/dev/null
    die "origin/$RELEASE_BRANCH did not take the release: it moved past $(git rev-parse --short "$TIP") after this cut last read it, or refused the push. Nothing was pushed, and $RELEASE_BRANCH is back on $(git rev-parse --short "$CUT"), $CUT_IS. Cut again with --at $CUT to merge the release onto the head as it is then."
  fi
  [ "$RELEASE_BRANCH" = dev ] || git push -q origin "$TAG"
  PUSHED="pushed to origin"
else
  PUSHED="NOT pushed — run: git push origin $RELEASE_BRANCH$([ "$RELEASE_BRANCH" = dev ] || printf ' && git push origin %s' "$TAG")"
fi
RIDES=''
if [ "$RODE" -gt 0 ]; then
  RIDES="
  $RELEASE_BRANCH landed $RODE commit(s) past $(git rev-parse --short "$CUT") $DURING, so the
  release commit is merged onto it as $(git rev-parse --short "$LANDED"), which folds their fragments into [$NEW]
  too."
  [ "$RELEASE_BRANCH" = dev ] || RIDES="$RIDES A deploy that builds the branch head carries those landings, which this cut's suite did not run;
  the next cut's suite does."
fi
# The tag names the commit forge-dev serves (docs/adr/0002), which is the one pushed: the merge onto
# the moved head where the branch landed during the wait, and the release commit only where it is
# itself what landed. The release commit under a merge was never served, so a tag on it would name
# a build nobody ran.
if [ "$RELEASE_BRANCH" = dev ]; then
  DEPLOYS="Not tagged yet. The push deploys forge-dev (.github/workflows/deploy-dev.yml);
  once https://forge-dev-api.sidcorp.co/api/version serves $LANDED:
    git tag $TAG $LANDED && git push origin $TAG"
else
  DEPLOYS="No workflow builds from this tag. core and web reach forge-beta through their
  own Coolify deploy, which this script does not trigger."
fi

# ---- step 6: say what happened --------------------------------------------
cat <<EOF

  cut $TAG  ($(git rev-parse --short "$RELEASE"))
  $FOLDED fragment(s) written into [$NEW] - $DATE and deleted
  $(printf '%s' "${#VERSION_JSON_FILES[@]}") version file(s) at $NEW
  $PUSHED$RIDES

  $DEPLOYS
EOF
