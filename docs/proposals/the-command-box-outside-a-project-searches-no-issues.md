# The ⌘K box outside a project searches no issues

Found while working ISS-1334. Its judge typed `ISS-1280` into the top bar's `Search issues, runs… ⌘K`
box and got `No matches.`: the palette filtered a fixed command list and asked no server. ISS-1334
now sends the palette's text to the issues search of the open project
(`features/shell/issue-search-commands.ts:useIssueSearchCommands`), so inside a project a key or a
phrase finds its issues there.

## What is left

On a page that belongs to no project — `/projects`, `/attention`, `/runners`, settings — the palette
has no project to ask, so a key or a phrase typed there still finds no issue, though the button
still says `Search issues`.

Answering it needs a search across every project the person can read. No such route exists:
`GET /api/projects/:id/issues/search` is per project by design, and ISS-1334 put cross-project search
out of scope. A key alone does not settle it either: `ISS` is the prefix every project answers to, so
`ISS-1280` names one issue in each project that has reached 1280, and a cross-project answer is a
list to choose from, not a row.

## Honest costs

A person on a page outside a project who types a key into ⌘K is told `No matches.`, the symptom
ISS-1334 was filed for, until they open the project first. Inside a project the same text answers.

## What would close it

A route that searches the projects a person can read, answering per project, with the palette
showing each hit under its project's name. The button's wording would stop overpromising on pages
outside a project only once that route exists, or once the wording says what it searches.
