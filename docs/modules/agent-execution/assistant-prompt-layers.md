# The assistant's prompt layers

The text the assistant is given at each door is composed from layers, one module per layer, under
`packages/core/src/assistant/prompt/`. A layer holds its text and its header and no other code;
`layer.ts:composeLayers` is the only thing that reads one.

## Why it is layered

Before ISS-1057 the instructions were one text per door with no seam. The channel-neutral method
lived in `guides/assistant-method-guide.ts` with the tool rules and the persona interleaved in one
template string; the identity line, the issue-link rule and the web door's lines lived in
`assistant/door-persona.ts`; the room's lines in `integrations/rocketchat/persona.ts`; and a fourth
copy of the tool rules in the `forge` tool's own description. A change to one was a change to all,
and nothing said which of them a benchmark figure was measuring.

## The six layers, and the order a door renders them

`layers.ts` holds the orders; a door names one and supplies its values.

| Layer | What it is |
|---|---|
| `identity` | who the assistant is and where it is speaking |
| `base` | how a request gets worked — investigate, own it, what a reply owes |
| `tools` | the tracker is the `forge` tool, the verb forms it carries, and filing |
| `linking` | the seam to the channel, and the one issue-link shape the web opens |
| `door-web` | what is true of the Forge web app and nowhere else |
| `door-rocketchat` | what is true of a Rocket.Chat room and nowhere else |

Both doors render `identity`, `base`, `tools`, `linking`, then their own door layer.
`ASSISTANT_METHOD_GUIDE.body` — what `forge_guide get answering-as-the-assistant` serves — is
`base` and `tools` composed, so no sentence has a second copy.

## Values, and the two kinds of absence

`composeLayers(layers, values)` fills `{token}` from a values map. The two absences are not the
same and the composer keeps them apart:

- A token whose value is `null` **drops the line that reads it**. That is how a room with no bot
  name renders no bot-name line, and how a door with no project slug renders no link line.
- A token the values map **does not name at all** throws, naming the layer and the token. A typo in
  a token would otherwise be an instruction that silently left the persona, which no reader of the
  rendered text can see.

An absent web origin is passed as the empty string, not `null`: the link then renders
root-relative, which is right for a reader already inside the app.

## Each layer names the tasks that measure it

Every layer carries a `benchTasks` header naming the `bench:assistant` tasks that exercise it, and
`compose.test.ts` holds those names to a frozen manifest that carries a reason for each pair and to
the ids `loadTasks()` actually ships. A layer that names none — `door-rocketchat`, because the
benchmark walks the browser door only — says why in its own `whyUnmeasured` field rather than
borrowing another door's task.

## How a layer change is measured

A change to a layer lands with a `bench:assistant compare <before> <after>` run against beta, and
pass^k must not be lower on any task afterwards. The run command and how to read a comparison are
in [`assistant-bench.md`](./assistant-bench.md).

**Both runs must be attributable to one build each.** Beta is shared and other issues deploy to it.
Read beta's own deployment record rather than sampling what it is serving: the Coolify deployment
list for the beta app gives every deployment with its commit and its start and finish times, so a
run stands only where no deployment window overlaps it. An unfinished deployment overlaps everything
after it starts, and the commit a run is attributed to is the last deployment that *finished
successfully* before it. `GET /version` either side of a run is corroboration, not the proof — it
cannot see beta deploy away and back between two reads.

## Where the gates read this text

`scripts/check-injected-doc-modes.mjs` reads `base.ts` and `tools.ts` as surfaces, because the
guide's body is composed from them. It also holds `assistant-method-guide.ts` to carrying no body
literal of its own: a body written back there would be injected text that gate could not see.

`persona-accounting.test.ts` is the claim ledger. Every instruction has one owning fragment, no
sentence of any layer appears in a second layer, and no sentence goes unclaimed.
