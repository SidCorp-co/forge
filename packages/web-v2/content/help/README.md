# End-user help docs (`packages/web-v2/content/help/`)

This folder is the **product documentation shown to end users** in the app at
`/docs`, and to anyone, signed in or not, on the public documentation at `/guides`
(behind the door "I use Forge"). It is bundled
into the **web build** (Hướng A — embedded MDX/Markdown), so it ships with the
frontend and is **never** read off a backend filesystem.

This is one of Forge's four documentation homes. Which page belongs here rather than in
another, who a page here may be written for, and the voice each of those readers is owed are
stated once, in
[where-a-page-lives.md](../../../../docs/modules/guides/where-a-page-lives.md).
In short: a page about how to use Forge on its screens belongs here, and a page about how the
code works never does.

## Authoring rules

- **Voice:** the rule for the page's `audience`, in
  [where-a-page-lives.md](../../../../docs/modules/guides/where-a-page-lives.md).
  Beyond it: plain language, task-first, no `ISS-###` and no pipeline-agent ceremony.
- **One task per page.** Title starts with a verb ("Pair a runner", not
  "Runners").
- **Page shape:** intro → Prerequisites → numbered, copy-pasteable steps →
  "Verify it worked" → Troubleshooting.
- **Links:** only to other pages in this folder, or to public external URLs.
  Never link into `docs/` or the source tree. A link to another page is written
  `[Its title](?path=<slug>)`, the slug being the page's path under this folder
  without `.md` — `pair-a-runner`, or `<folder>/<page>` for a page in a subfolder.

## Frontmatter

Every page starts with:

```md
---
title: Pair a runner
section: Getting started   # sidebar group
order: 20                  # sort within the section (ascending)
audience: user             # user
---
```

`section` groups pages in the sidebar; `order` sorts within a section.
Sections render in the order `HELP_SECTION_ORDER` in `packages/web-v2/src/features/docs/reader.ts`
lists them, and any section it does not list falls to the end alphabetically — so
a new section is added there.

`audience` says who the page is written for, and decides which door of the public
documentation it sits behind: `user`, for someone using Forge. It is required;
`pnpm gen:help` refuses a page with no front-matter, no `audience` or any other value,
naming the file. Why `agent` is not a value here, and the voice rule each value is held to:
[where-a-page-lives.md](../../../../docs/modules/guides/where-a-page-lives.md).

## Structure (Diátaxis, for the product)

| Section | Purpose | Example pages |
|---|---|---|
| Getting started | one end-to-end first run | Getting started · Pair a runner |
| Guides | one task each | Ask for a change · Tell when an issue is done · Manage your organization |
| Concepts | product-level mental model | none yet |
| Reference | look-ups | Read an issue's status |
| Troubleshooting | when stuck | Troubleshooting |
