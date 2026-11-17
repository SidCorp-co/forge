# Find: one search door, and what became of the other searches

`POST /api/projects/:id/find` (`packages/core/src/find/routes.ts`) and `forge_find`
(`packages/core/src/mcp/find-records.ts:findRecords`) read one function,
`packages/core/src/find/service.ts:runFind`. It runs every arm of every record type, fuses their ranked
lists by reciprocal rank (`packages/core/src/lib/search-fusion.ts:fuseRanked`), and then filters by
type, module and status. ISS-1256 criterion 5 asks that every other search is deleted or becomes a
**filter** of this door. A filter calls `runFind` with the types it answers and reads `kept`. `kept`
is the fused candidates the query's filters keep, best first, cut to the limit, so the filter
answers the hits `POST /find` answers for the same words and types, in the same order. A filter
keeps no ranking of its own. It takes no `strategy`: one sent is refused by name
(`packages/core/src/lib/search-fusion.ts:retiredSearchStrategy`).

A filter passes `filterOnly`, so only the arms that can find one of its types run
(`packages/core/src/find/service.ts:ARM_TYPES`). Skipping the other arms changes no rank. A hit's
fused score is summed only from the lists that hold it, and no list of another type holds it. A
filter's miss is never recorded as a find gap, because the other types were never asked.

`packages/core/tests/integration/find-filters-e2e.test.ts` asserts that each folded door answers what
`POST /find` answers for the same query and types.

## The eight searches

| search | was | now | callers |
|---|---|---|---|
| knowledge search | `POST /api/projects/:id/knowledge/search` (`packages/core/src/knowledge/routes.ts`), `forge_knowledge` `search` (`packages/core/src/knowledge/tool.ts`), the `recall` port (`packages/core/src/knowledge/ports.ts`). It ranked with a `strategy` of its own, `semantic` by default. | **folded**: `packages/core/src/find/recall-filter.ts:recallThroughFind`. The knowledge list is the door's `term`, `rule`, `lesson` and `knowledge` filter, and the memory list is its `memory` and `decision` filter, each cut to `topK`. | Agents through the guides and orientation (`packages/core/src/guides/registry.ts`, `packages/core/src/lessons/block.ts`). `packages/core/src/support/search.ts` reads the door through `findRecords` (support search, below). web-v2: none. forge-plugin: none, because its `forge knowledge search` refuses by declaration. |
| knowledge unified-search | its own file in the knowledge module, a second fusion of knowledge and memory | **deleted** (ISS-1256, 70034ef1d1) | none |
| memory search | `POST /api/memory/search` (`packages/core/src/memory/search-routes.ts`) and `forge_memory` `search` (`packages/core/src/memory/tool.ts`), both over `packages/core/src/memory/search-service.ts:runMemorySearch`. Each ranked with a `strategy` of its own and no floor. | **folded**: `packages/core/src/find/memory-filter.ts:memoryThroughFind`, reached through `packages/core/src/memory/find-port.ts`. It answers the door's `memory` and `decision` filter, and `sourceFilter` narrows the memory arm's curated sources. A mirror source (`issue`, `comment`, `job`) is refused by name. `runMemorySearch` is now only the store read behind the door's memory arm and the note gate, and no door answers it. | Agents through the orientation and the drive rules (`packages/core/src/prompt/checkout-orientation.ts`, `packages/core/src/prompt/facts/drive-rules.ts`). forge-plugin: `forge_memory.search` and the filing neighbours (below). |
| issues search | The issue list's text filter: `GET /api/projects/:id/issues/search?q=` (`packages/core/src/issues/search.ts`), the list's `search`, and `issues.list` `search`, all through `packages/core/src/issues/list-service.ts:listIssues`. It matched words as substrings and sorted newest first. | **folded**: `packages/core/src/find/issue-filter.ts:issueIdsThroughFind`, reached through `packages/core/src/issues/find-port.ts`. It lists the issues the door's issue filter keeps, at most `FIND_LIMIT.max`. The list's other filters narrow that set. It reads in the door's order unless a `sort` is sent. | web-v2: the issue list (`packages/web-v2/src/features/issues/api.ts`) and the issue picker (`packages/web-v2/src/features/issue-picker/api.ts`). forge-plugin: its issue list and four readers (below). |
| MCP records-search | MCP `search` (`packages/core/src/mcp/records-search.ts:searchRecords`). It read the fused list whole. | **folded**: it reads `kept`, cut to its limit. | ChatGPT's connector and deep research |
| support search | `support.search` (`packages/core/src/support/search.ts`), the room's how-to search. It matched words in the project's knowledge and the published API operations. | **folded**: `findRecords` (`packages/core/src/knowledge/ports.ts`), the door's own fused order over the room's project, filtered to `term`, `rule`, `knowledge`, `lesson` and the followed reference sources. A miss is kept as the project's gap. The published API operations stay a contract lookup beside the search, not a record type of it. | the channel rooms' turns (`packages/core/src/support/room-cards.ts`) |
| product-progress home-find | `GET /api/me/home/find` (`packages/core/src/product-progress/home-find.ts`). It put an exact key first. | **folded**: each project's `kept` for `issue` and `feedback`, the projects merged by the door's fused score. | the owner's home (`packages/contracts/src/owner-home.ts:HomeFindResponse`) |
| conversation transcript-search | the room tool `conversation_transcript_search` (`packages/core/src/assistant/tools/transcript-search-tool.ts`), over `packages/core/src/conversations/transcript-search.ts:searchConversationTranscript` | **folded**: `packages/core/src/find/transcript-filter.ts:transcriptThroughFind`, reached through `packages/core/src/assistant/tools/transcript-port.ts`. It answers the door's `conversation` filter over the room, with the room read's coverage and limits. `searchConversationTranscript` is now only the store read behind the door's conversation arm. | the chat room's turns (`packages/core/src/assistant/chat-room/images.ts`) |

## forge-plugin's callers

These callers are in the forge-plugin repository. That repo is reached by issue, never by a diff from here.

<!-- doc-citation: unchecked `plugin/src/tracker/declared/no-route.mjs` — a path in the forge-plugin repository, not this tree -->
- `plugin/src/tracker/declared/no-route.mjs` declares `forge knowledge search` as having no route.
<!-- doc-citation: unchecked `plugin/src/tracker/routes.mjs` — a path in the forge-plugin repository, not this tree -->
- `plugin/src/tracker/routes.mjs` serves `forge_memory.search` through `POST /api/memory/search`. It
  also serves the issue list, which uses `issues/search` when a search is set.
<!-- doc-citation: unchecked `plugin/src/tracker/filing/neighbours.mjs` — a path in the forge-plugin repository, not this tree -->
- `plugin/src/tracker/filing/neighbours.mjs` sends `strategy` and `sourceFilter: ["issue"]` to memory
  search. Both are now refused. It also reads `score` as a cosine against its floors, and `score` is
  now the door's fused score.
<!-- doc-citation: unchecked `plugin/src/trace/citing.mjs` `plugin/src/tracker/issue-shape.mjs` `plugin/src/git/reviewed.mjs` `plugin/src/rank/prose-edges.mjs` — a path in the forge-plugin repository, not this tree -->
- Four readers walk the issue list's `search` for a literal marker or id: `plugin/src/trace/citing.mjs`,
  `plugin/src/tracker/issue-shape.mjs`, `plugin/src/git/reviewed.mjs`, `plugin/src/rank/prose-edges.mjs`.
  The list now answers the door's issue filter: hits by meaning are included, and the walk ends at
  `FIND_LIMIT.max`.

## What the door does not hold

Core's comment and job copies in memory are no find type. A memory search naming one is refused, and
the refusal says they are read through their issue. Folding them in would take three things: a
`comment` and a `job` find type (`packages/contracts/src/find.ts:FIND_TYPES`), memory-arm lists over
those sources, and an open path and egress surface for each (`packages/core/src/find/open.ts`).
