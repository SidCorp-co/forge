# CHANGELOG append (Step 4.5) — forge-release

After the merge commit lands and post-merge tests pass, read the issue's typed `releaseNotes` field and append a bullet under the matching `### <section>` of `## [Unreleased]` in `CHANGELOG.md`.

The bullet later gets promoted by `forge-cut-release` into a versioned `## [X.Y.Z]` section.

## `releaseNotes` shape

```typescript
{ section: 'Added'|'Changed'|'Fixed'|'Removed'|'Security'|'Skip',
  userFacing: string,
  technical?: string|null }
```

Returned as a field on `forge_issues → get` response (drafted by `forge-clarify`).

## Driver

```bash
# After Step 4 (re-test) passes, before Step 5 (push target):

NOTES=$(forge_issues get --documentId "$DOCID" | jq -r .releaseNotes)

if [[ "$NOTES" != "null" ]]; then
  SECTION=$(jq -r .section <<<"$NOTES")
  if [[ "$SECTION" != "Skip" ]]; then
    USER_FACING=$(jq -r .userFacing <<<"$NOTES")
    TECHNICAL=$(jq -r '.technical // ""' <<<"$NOTES")
    bash .claude/skills/forge-release/scripts/append-changelog.sh \
      CHANGELOG.md "$SECTION" "$USER_FACING" "$TECHNICAL"

    if ! git diff --quiet CHANGELOG.md; then
      git add CHANGELOG.md
      # Stage the CHANGELOG into the SAME merge commit from Step 3
      # via `git commit --amend --no-edit` — keeps history clean.
      git commit --amend --no-edit
    fi
  fi
fi
```

The script handles every Section value internally:

| `releaseNotes` state | Driver behavior |
|---|---|
| `null` | skip entirely (no bullet) |
| `section: "Skip"` | skip entirely |
| `section: "Added"|"Changed"|"Fixed"|"Removed"|"Security"` | script appends bullet under that subsection; creates the subsection if missing |
| `userFacing` contains `ISS-NNN` | script exits 2 (style violation) — abort release, post comment routing back to forge-clarify |
| any other bad section | script exits 2 — same routing |

## Staging into the merge commit

`git commit --amend --no-edit` folds the CHANGELOG.md change into the merge commit from Step 3. This keeps the history readable — one commit per issue, including its changelog entry, rather than a merge commit + a follow-up CHANGELOG commit.

If the merge was already pushed in a prior attempt and crashed mid-release (rare — Step 5 push is the last step), amend is no longer safe. Instead make a follow-up commit `chore(release): CHANGELOG for ISS-XX` and push to `$TARGET` separately.

## Style guard

The script rejects (exit 2) any `userFacing` value containing `ISS-NNN` — that's a marker the bullet was lifted from internal tracking and never rewritten for end users. Redraft via `forge-clarify` if this fires.

Other style rules (no jargon, lead with user outcome, optional concrete number) live in `docs/guides/release.md` → "Writing changelog entries — style guide". The script enforces only the ISS-NNN check programmatically — the rest is a forge-clarify drafting concern.

## Auto-create subsection

If `### <section>` doesn't exist under `## [Unreleased]` (e.g. someone manually pruned the empty subsections), the script creates it before inserting the bullet. The `forge-cut-release` flow recreates all 5 subsections, so this fallback rarely triggers in normal operation.

## Recovery if the script fails

The script writes via `CHANGELOG.md.tmp && mv`, so a failure leaves the original file intact. If the script exits non-zero:

- Exit 1: `## [Unreleased] header not found` — `CHANGELOG.md` is corrupted; restore from git and re-run.
- Exit 2 with "Bad section": `releaseNotes.section` value isn't one of the 5 valid sections — fix the issue's draft via `forge-clarify` and re-run.
- Exit 2 with "Style violation": `userFacing` contains `ISS-NNN` — same fix path.

No need to revert anything — the script is fail-safe.
