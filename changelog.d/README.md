# Unreleased changelog entries

One change, one file: `changelog.d/<name>.<section>.md`.

- `<name>` is the branch or issue that writes it, lower-case kebab, so no two branches write the
  same path.
- `<section>` is one of `added`, `changed`, `fixed`, `removed`, `security`.
- The file holds one entry: it opens with a bold lead, runs to at most 40 words, and has no bullet
  marker, no heading and no second paragraph.

```text
**Cancelling a running pool job now stops it.** The box closes its session and the job reads cancelled.
```

Two optional forms feed the in-app What's new, which reads this record:

- **A tour.** An entry that introduces a screen with a product tour closes with one more line,
  `tour: <id>` (an id of `PRODUCT_TOURS` in `packages/contracts/src/tours.ts`). The release keeps it
  in the version section as an invisible HTML comment, and the entry offers "Show me". An id the
  catalog does not hold fails the build naming the file, version and line.
- **A weekly digest.** `changelog.d/digest-<year>-w<nn>.digest.md` (lower-case, such as
  `digest-2026-w41.digest.md`) is the summary of that ISO week: a bold title, then at most 120
  words in the same paragraph. The weekly schedule reads the past week from `CHANGELOG.md` and
  lands it through the normal flow; the release folds it under `### Digest`.

`scripts/cut-release.sh` folds every file here into the new version section of `CHANGELOG.md` and
deletes them in the release commit. `CHANGELOG.md` holds released sections only, and
`node scripts/check-release-record.mjs` refuses an entry written into it directly. This file is the
one the release leaves in place.
