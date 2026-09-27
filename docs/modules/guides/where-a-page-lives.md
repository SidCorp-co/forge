# Where a documentation page lives

Forge keeps documentation in four homes. This is the one statement of which page goes in which,
who each is written for, and how it has to read. The READMEs of the homes and the header comments
of the modules that serve them point here rather than restating it.

**A page lives with the thing it describes.** A screen ships with the frontend. A rule of the
system ships with core. An external service lives in the database, where it can be corrected
without a release. How the code works is not shipped at all.

| Home | Describes | `audience` | Ships | Declared by | Checked by |
|---|---|---|---|---|---|
| `packages/web-v2/content/help/` | how to use Forge, on its screens | `user`, `assistant-setup` | the web build | each page's front-matter | `readPage` and `readAudience` in `packages/web-v2/scripts/help-frontmatter.mjs`, at `pnpm gen:help` |
| `packages/core/src/guides/registry.ts`, served at `/api/guides` | a rule of the system agents are held to | `agent` | core | `audience` on each `ForgeGuide` in `packages/core/src/guides/types.ts` | the type, and `packages/core/src/guides/registry.test.ts` |
| the `integration_guides` table | an external service, per organisation | `agent` | the database | the home: `resolveGuide` and `resolveGuideIndex` in `packages/core/src/guides/integration-guides.ts` set it on every row they return | `packages/core/src/guides/integration-guides.test.ts` |
| `docs/` | how the code works | none | never | — | — |

## Why each home is where it is

- **A screen changes with the frontend**, so its page is bundled into the web build and changes in
  the same pull request. The backend never reads that folder.
- **A rule of the system changes with the code that enforces it.** A registry guide ships
  atomically with that code and is reviewed with it; it needs no per-environment seeder that can
  silently diverge; it has no project, so there is nothing to gate and no membership bypass to bolt
  onto project knowledge. Runtime-editable, per-project guidance already exists one tier down, as
  `forge_knowledge` entries, and the registry does not duplicate it.
- **An external service changes on someone else's schedule.** A guide about it is corrected by an
  organisation admin without waiting for a Forge release. It shares the registry's slug space as
  `integration-<provider>`, and a row shadows the code default of the same slug.
- **The code describes itself.** `docs/` is read in the repository by contributors, operators and
  coding sessions, and is never served to anyone.

## The `audience` field

`audience` takes one of three values — `user`, `assistant-setup`, `agent` — and it decides the door
of the public documentation a page sits behind, the voice it is written in, and the home it lives
in. The three name the readers a **served** page can have. `docs/` is never served, so its pages
declare no `audience`: their home is their declaration, and the requirement that every page carry
the field means every page that is served.

Each served home admits only some of the three. Core's two homes admit `agent` alone, and a help
page may not be `agent`, for the same reason: the agent door promises every page behind it as plain
markdown at `/api/guides/<slug>.md`, which only core can keep. The public documentation reads the
value core declared for each guide, in `fromGuide` in
`packages/web-v2/src/features/guides/corpus.ts`, and refuses one it cannot place.

## How each audience's pages read

| `audience` | The rule | Checked by |
|---|---|---|
| `user` | Names nothing the screen does not show: no file path, no table or column name, no MCP tool name, no status in its stored form, and no promise of how long anything takes. `forge-runner` is allowed — it is the program a runner's owner installs and types. | `packages/web-v2/src/features/docs/help-user-vocabulary.test.ts`, over every page declaring it |
| `assistant-setup` | Every numbered step ends in something the reader can see, written as a `**Check:**` line. | `packages/web-v2/src/features/docs/help-assistant-setup.test.ts`, over every page declaring it; `STEP_RULE_EXEMPT` there names a page that does not meet it yet, and refuses the entry once it does |
| `agent` | Every page names what it forbids or requires. A page that only describes belongs to one of the other two. | review — a script looking for rule words passes every guide on the word "only", which grades nothing |

A page that cannot pass its own audience's rule is in the wrong home or is written for the wrong
reader.
