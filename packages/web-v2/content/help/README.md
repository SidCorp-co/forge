# End-user help docs (`packages/web-v2/content/help/`)

This folder is the **product documentation shown to end users** in the app at
`/docs`. It is bundled into the **web build** (Hướng A — embedded MDX/Markdown),
so it ships with the frontend and is **never** read off a backend filesystem.

> **THE RULE — two homes, never mixed:**
>
> | | repo-root `docs/` | `packages/web-v2/content/help/` (here) |
> |---|---|---|
> | What | **CODE / engineering docs** | **END-USER product guide** |
> | Audience | contributors, maintainers, operators, AI coding sessions | people *using* Forge |
> | May reference | source paths (`packages/…`), `ISS-###`, architecture, internals | only product UI + behavior |
> | Ships in the product | **never** | yes (web build) |
> | Rendered at `/docs` | **never** | the **only** source |
>
> If a page talks about *how the code works* → it belongs in `docs/`.
> If a page talks about *how to use Forge* → it belongs **here**.

The backend does **not** read this folder, and `docs/` is **never** served to
users — the separation is structural (different package trees), so the two
cannot leak into each other.

## Authoring rules

- **Voice:** write for a product user, not a developer. Plain language,
  task-first. No repo internals, no `ISS-###`, no `packages/…` paths, no
  pipeline-agent ceremony, no architecture/RFC/threat-model material.
- **One task per page.** Title starts with a verb ("Pair a runner", not
  "Runners").
- **Page shape:** intro → Prerequisites → numbered, copy-pasteable steps →
  "Verify it worked" → Troubleshooting.
- **Links:** only to other pages in this folder, or to public external URLs.
  Never link into `docs/` or the source tree. A link to another page is written
  `[Its title](?path=<slug>)`, the slug being the page's path under this folder
  without `.md` — `pair-a-runner`, or `connect-an-assistant/cursor` for a page in
  a subfolder; `help-links.test.tsx` refuses any other form and any slug no page has.
- **Subfolders** group a set of pages that answer one reader's questions together.
  `content/help/connect-an-assistant/` is the one there is: connecting Claude
  Desktop, Claude Code, Cursor or another app to Forge, written for someone who
  has never heard the word "MCP".
  `src/features/docs/help-assistant-setup.test.ts` holds its rules.

## Frontmatter

Every page starts with:

```md
---
title: Pair a runner
section: Getting started   # sidebar group
order: 20                  # sort within the section (ascending)
---
```

`section` groups pages in the `/docs` sidebar; `order` sorts within a section.
Sections render in the order `SECTION_ORDER` in `docs-screen.tsx` lists them, and
any section it does not list falls to the end alphabetically — so a new section
is added there.

## Structure (Diátaxis, for the product)

| Section | Purpose | Example pages |
|---|---|---|
| Getting started | one end-to-end first run | Create a project · Pair a runner · Run your first issue |
| Guides | one task each | Manage your org & members · Configure the pipeline · Connect an integration · Move a project to another org |
| Connect an assistant | use Forge from an assistant the reader already has | What connecting does · Claude Desktop · Claude Code · Cursor · Another app · What you can ask · When it does not work |
| Concepts | product-level mental model | Project · Device & runner · Pipeline · Organization |
| Reference | look-ups | Pipeline stages · Roles & permissions · Settings |
| Troubleshooting | when stuck | Device offline · Job stuck in queue · Pairing code expired |

## Do NOT put here

Architecture, RFCs, proposals, threat models, ADRs/decisions, module design,
VISION, contributor/release/branching guides — those are internal and live in
the repo-root `docs/` tree.
