# An issue title reaches the MCP list projection char-stripped and not framed

**Status:** open residual, measured. No code proposed here, because the fix is a decision about a
token cap and not about any one filer.

**Found by:** ISS-1085 slice 3, which built the first path that files Forge issues from an external
error tracker and had to say, in a criterion, exactly where its untrusted text is framed. The claim
"framed wherever an agent reads it" turned out to be false, and this file is what stops that
sentence being written again.

## What is true today

`prompt/sanitize.ts` gives two treatments, and they are not interchangeable:

- `sanitizeUntrusted` strips invisible, bidi and Unicode-tag-block characters and unwraps HTML
  comments. It neutralizes smuggling. It does **not** tell the model the span is data.
- `markUntrusted` does that, then wraps the text in a labelled `⟦UNTRUSTED_DATA source="…"⟧` frame,
  stripping the frame tokens out of the content first so the content cannot forge its own closer.

Three agent-facing projections carry an issue title:

| Projection | Treatment |
|---|---|
| `prompt/user.ts` — the pipeline prompt | `markUntrusted`, title and description |
| `mcp/tools/forge-issues.ts:serialize` — MCP `get` / write-returns / `forge_step_start` | `markUntrusted`, title and description |
| `mcp/tools/forge-issues.ts:serializeListRow` — MCP `list` | **`sanitizeUntrusted` only** |

The third is deliberate and its rationale says so: a full DATA banner is ~120 characters, and the
lean list projection exists precisely to keep a browse over many issues inside the MCP token cap
(ISS-428, ISS-532). At a 50-row list that is ~6,000 characters of banner.

So the gap is real and it is priced. It is recorded here rather than closed because closing it is a
decision about **every issue title from every source** — a human's, a GitHub mirror's, an agent's —
taken on the strength of one new filer, in the busiest MCP projection this repo has.

## Why it is not simply "low risk"

The reassuring reading is that a list row is only a browse. That reading is not free: an agent
choosing what to work on reads titles in `list`, and a title is the one untrusted field the lean
projection still carries. Nothing here claims an exploit; what is claimed is that the two halves of
`prompt/sanitize.ts`'s own doctrine are not both in force on this path, and that the reason is
budget rather than analysis.

`integrations/sentry/chokepoint.test.ts` asserts the current behaviour — that the list title is
char-stripped and **not** framed — so whoever changes it gets a red test pointing at this file
rather than a silent change to a trade-off somebody priced.

## The three shapes a fix could take

1. **Frame it and pay the tokens.** One line. Re-measure a 50-row list against the cap; if it no
   longer fits, the cap or the page size moves, which is the real cost.
2. **A bounded frame for list rows** — a single-line sentinel (`⟦UD⟧…⟦/UD⟧`) used only by the lean
   projection. Cheaper in tokens, but it is a second frame vocabulary, and a model taught two is
   taught neither reliably.
3. **Leave it and say so in the tool description**, so an agent reading `list` output knows titles
   there are data. Costs nothing and defends nothing; it is the option that should be chosen
   explicitly or not at all.

## Honest costs

**What adopting this costs whoever adopts it.**

- **Option 1** costs prompt budget on the hottest MCP read there is, and the number is not known
  until somebody measures a real list against the cap. It also changes what every existing agent
  sees in `list`, on every project, in one deploy — there is no per-project rollout for a
  serializer. Budget: an hour to change, a day to measure and decide whether the page size moves
  with it.
- **Option 2** costs a second frame vocabulary forever. Every future reader of `sanitize.ts` has to
  learn which projection uses which, and the "model taught two frames" risk is unmeasured and hard
  to measure. Budget: a day, plus an unbounded teaching cost.
- **Option 3** costs nothing to write and buys nothing enforceable. Its real price is that it makes
  the gap look answered.
- **Doing none of them** costs exactly what it costs today, which is what this file records: one of
  three agent-facing projections carrying untrusted text without the frame the other two apply. The
  test named above is what keeps that fact from going quiet.
- **Whoever takes this** needs the measurement first — a real 50-row `forge_issues list` against the
  MCP token cap, before and after — because every option above is a trade against a number nobody
  in this repo has written down.
