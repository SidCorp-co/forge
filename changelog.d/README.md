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

The in-app What's new no longer reads this record: it shows the release the instance serves, from
that release's own page. A closing `tour: <id>` line is still accepted and folded, but nothing reads
it, so write none. A `digest-<year>-w<nn>.digest.md` fragment is refused like any other section.

`scripts/cut-release.sh` folds every file here into the new version section of `CHANGELOG.md` and
deletes them in the release commit. `CHANGELOG.md` holds released sections only, and
`node scripts/check-release-record.mjs` refuses an entry written into it directly. This file is the
one the release leaves in place.
