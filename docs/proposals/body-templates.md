# Body templates

Issue and comment bodies as allowlisted HTML: a set of `forge-*` components with typed
attributes and slots, plus a fixed set of plain text tags. Markdown stays for existing rows.

**Status:** P1 shipped by ISS-898 (2026-09-03) — the registry, the kernel gate, the columns,
`forge_comments.update`, and the read projection. P2–P4 are unstarted and unfiled. Decisions
1–9 were locked by the owner on 2026-09-03; a rejected option in §7 stays rejected.

## 1. Why a guide was not enough

Compliance tracks where the format lives, not how well it is written. Measured on forge-beta
2026-09-03, over rows created since the `writing-an-issue` v2 guide landed 2026-08-12:

| Where the format lives | Compliance |
|---|---|
| Guide, reachable only from a tool description | 14–28 % of issues · 0.02 % of comments |
| The stage skill's own body, which the agent copies | near 100 % |
| A zod `.strict()` refusal (`releaseNotes`) | 100 % |

| Population since 2026-08-12 | Total | Opens with a blockquote | *Who it hurts* | Mermaid | Evidence |
|---|---|---|---|---|---|
| forge-dev issues | 57 | 14 | 8 | 8 | 16 |
| Fleet issues | 1,029 | 98 | 33 | 44 | 87 |
| Fleet agent comments | 5,286 | — | — | 1 | — |

20 fleet issues already contain raw `<p>` / `<div>` / `<img>` that render as literal text: the
renderer has no `rehype-raw`. People wanted HTML before the system accepted it.

## 2. Two kinds of HTML, two paths

|  | Self-contained styled page | Allowlisted component markup |
|---|---|---|
| Path | attachment, rendered in a sandboxed iframe, placed with `<forge-artifact id>` | the body itself |
| Why split | inlining unsandboxed HTML is XSS on content anyone can post, and a full page blows the 8,000-char description cap | no script, style, iframe, event handler, `style=` or `class=`; renders inline with the design system |

## 3. The shape

```mermaid
flowchart TB
  subgraph R["Registry — packages/core/src/body/"]
    C["component: name · attribute schema · child slots · toText()"]
    A["plain tag allowlist — exactly what GFM already emits"]
  end
  subgraph K["Kernel, on write"]
    X["lift forge-diagram out as raw text"] --> P["strict scan"]
    P --> S["sanitize plain · validate forge-*"]
    S --> V{"valid?"}
    V -- "no" --> E["400 BODY_INVALID naming element / attribute / slot"]
    V -- "yes" --> N["normalize → body · format · template"]
  end
  subgraph READ["Read"]
    W["web: components → design system (P2)"]
    G["MCP: body + slots + text"]
    T["prompt · embedding: toText()"]
  end
  R --> K
  N --> W
  N --> G
  N --> T
```

Storage — `format` and `template` are the only new columns per body. There is no blocks tree:
the body is the single source of truth and the server re-parses on read (Decision 8).

| Column | Meaning |
|---|---|
| `comments.body` / `issues.description` | canonical bytes; for `format='html'`, sanitized and normalized |
| `comments.format` · `issues.description_format` | `markdown` (the default, and every pre-existing row) or `html`. CHECK-constrained |
| `comments.template` · `issues.description_template` | root component name — replaces the regex guess in `deriveCommentKind` |

Two rules with two outcomes, and conflating them is the mistake to avoid:

- **Plain markup is repaired and reported.** Unknown tag unwrapped, disallowed attribute
  dropped, `<script>` removed whole, each named in `warnings[]`. Never a refusal — Decision 3
  makes prose always valid, and tag-free text is wrapped in `<p>` by blank line.
- **`forge-*` markup is refused and named.** 400 with the element, the attribute and its legal
  set, or the missing slot, in the message.

## 4. The first component set

Roots: `forge-triage` · `forge-plan` · `forge-review` · `forge-qa-report` · `forge-outcome` ·
`forge-blocked` · `forge-close` · `forge-symptom` · `forge-problem` · `forge-diagram` ·
`forge-artifact`. Slots: `forge-finding` · `forge-summary` · `forge-case` · `forge-failure` ·
`forge-extra-fix` · `forge-opening` · `forge-who` · `forge-todo` · `forge-decision` ·
`forge-evidence` · `forge-row` · `forge-relations` · `forge-files`.

The registry is the authority on attributes and slots: `packages/core/src/body/components.ts`.
Each descriptor carries its own `toText()`, which is what the four read paths share.

One level of nesting (Decision 5): a root, its declared slots, plain tags inside. `forge-diagram`
and `forge-artifact` are leaves and are legal inside any slot — a component with no slots opens
no second level to recurse into.

## 5. Where the proposal was wrong about the tree

Three implementation details in the original proposal do not survive contact with this
repository. Recorded here because P2–P4 would repeat them.

| Proposed | Actual | Why |
|---|---|---|
| registry in `packages/contracts/src/body-components.ts` | registry in `packages/core/src/body/`; contracts re-exports the TYPES | `contracts-runtime-boundary.test.ts` forbids core value-importing `@forge/contracts` — type-only, absent from core's production image, so a value import compiles and then crashes at boot (ISS-510). The dependency also runs contracts → core |
| projection at two sites: `prompt/user.ts`, `memory/indexer.ts` | four sites: those two plus both MCP serializers | under thin-init the per-state include lists default EMPTY, so the prompt inlines only the title. `forge-issues.ts:serialize` and `forge-comments.ts:serialize` are what actually carry a description or a comment to an agent |
| parse5 | a strict scanner in `body/parse.ts`, no new dependency | parse5 REPAIRS. Given `<forge-review><p>x</forge-review>` it relocates the `<p>` and reports nothing, so the 400 naming the mis-nested slot cannot exist. Over a closed tag set with one nesting level, strict rejection is the product |

A fourth, smaller: MCP `update` writes through the comments service, not REST
`PATCH /api/comments/:id`, which is `requireAuth()` and refuses a device principal.

## 6. Gaps the use-case walk surfaced, and where each lands

| # | Gap | Fix | Phase |
|---|---|---|---|
| 1 | prompt and embedding would receive raw HTML, so the 8,000-char cap holds fewer requirements | `toText()` in the registry, called at all four read paths | **P1 done** |
| 2 | MCP cannot edit a comment, so `<forge-artifact id>` can never be placed — the attachment needs a comment id that does not exist until after the create | `forge_comments` action `update` | **P1 done** |
| 3 | six skills parse upstream comments by string prefix, across two repos | readers accept both forms, THEN writers switch, THEN the regex goes | P3 — the order is mandatory |
| 4 | web cannot edit a description after create (`PatchIssueInput` carries only priority + complexity) | add `description` to the client input, plus a slot-shaped editor | P2 |
| 5 | `forge-diagram` content contains `-->` and `<br/>` and confuses any markup scanner | lifted out as raw text at the opening tag | **P1 done** |
| 6 | an older web build meets a component it does not know | generic fallback card listing attributes and slots — never a blank screen | P2 |
| 7 | the composer has no preview | debounced preview pane, reusing the rules tab's | P2 |

Gap 3 is the largest risk in the whole plan, and it is a sequencing risk rather than a design
one. P1 deliberately changes no writer: `format` absent resolves to `markdown`, and
`packages/core/skills/**` is untouched, so every shipped `forge_comments → create` example
still validates and no reader is blinded.

## 7. Rejected, and staying rejected

| Option | Why not |
|---|---|
| JSON `{template, data}` as the primary write syntax | high fill-in accuracy but rigid: prose and components cannot interleave, and reading it back needs its own projection. Kept as the shape a web form generates HTML from |
| markdown plus `:::who-it-hurts` directives | still free writing inside text, which §1 measures as not spreading; two syntaxes in one body confuse both the parser and the agent |
| `<forge-md>` holding markdown inside HTML | two syntaxes in one body make a nesting error unreportable |
| full raw HTML via `rehype-raw` | XSS on content anyone can post, breaks the prompt cap, and does not address filling it in correctly |
| improve the guide again | already done, in v2. §1 is the result |

## 8. Phases

| Phase | Scope | Touches |
|---|---|---|
| **P1** (ISS-898, shipped) | registry, kernel validate/normalize on write for comments and issue descriptions, the four columns + CHECKs, `forge_comments.update`, `slots`/`text` on read, projection at four sites, tests | `core`, `contracts` |
| P2 | web renderer (components → design system), fallback card, composer slash-insert + preview, new-issue shape picker, description editing on the detail screen | `web-v2` |
| P3 | readers accept both forms → writers switch → regex removed. A `{{forge:body-components}}` fact so a skill embeds the component list rather than copying examples. Lockstep with `forge-plugin` | `core/skills`, `prompt/facts`, `forge-plugin` |
| P4 | `bodyPolicy` per project and stage (the `RELEASE_RECORD_REQUIRED` mechanism, requiring a component rather than only validating one), adoption metrics per stage | `core`, `web-v2` |

The mandate ladder is separate from the phases and deliberately lags them: syntax refusal is on
from day one (P1), but *requiring* a component at a stage waits for two weeks of adoption data
(P4). A human writing plain prose is valid at every level.

## Honest costs

| Cost | Borne by |
|---|---|
| A ~250-line HTML scanner this repo now owns and maintains, with no HTML5 repair semantics — malformed markup is refused rather than fixed up | whoever next changes the body format |
| A second body syntax exists. Until P3 completes, a reader must handle `markdown` and `html`, and `deriveCommentKind` stays alive beside `template` | every reader of a body, for as long as P3 is unfinished |
| A refused write is a failed call. An agent that gets the component wrong loses a turn to the 400 — the price of the mechanism that produced 100 % compliance for `releaseNotes` | every agent, on its first mistake with a new component |
| Adding a component now means touching the registry, giving web a renderer, and (from P2) a fallback path — where before it meant writing a heading | whoever adds the next body shape |
| Four new columns and two CHECK constraints on the two largest tables | the migration, and any consumer reading `SELECT *` |
| The registry is core-internal, so P2's web renderer cannot import it and must hold its own component→React map. Two lists that must agree, with only `body/doors.test.ts`-style checks available to keep them honest | P2 |

## Evidence

| Date | Measured | Source |
|---|---|---|
| 2026-09-03 | the compliance and population tables in §1 | SQL on the forge-beta read-only replica, `created_at >= 2026-08-12` |
| 2026-09-03 | raw HTML in a body renders as escaped text — no `rehype-raw` | `packages/web-v2/src/design/patterns/markdown.tsx` |
| 2026-09-03 | comment kind is guessed from body text; `comments` had no kind column | `features/issues/derive.ts:deriveCommentKind` |
| 2026-09-03 | REST has `PATCH /api/comments/:id`; MCP `forge_comments` had list/create/delete only | `comments/routes.ts`, `mcp/tools/forge-comments.ts` |
| 2026-09-03 | the prompt injects only the title by default; the MCP serializers carry the bodies | `prompt/user.ts` per-state include lists, `mcp/tools/forge-issues.ts:serialize` |
| 2026-09-03 | `text(col, { enum })` emits no constraint — Postgres accepted `format='rst'` until `0197`/`0198` added the CHECKs | `tests/integration/body-format-e2e.test.ts`, which failed on exactly that before they existed |
