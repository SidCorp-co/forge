# A private clarification has no stated preference, and no consent gate

ISS-1091 made the destination of a clarifying question its origin's rather than the project's, and
built the direct room as a real destination for a round the asker marked `sensitive`. Two halves of
that issue's outcome 2 did not land with it. Neither is a defect in what shipped; both are work no
diff on that branch could carry.

## 1. "Or where the asker has a stated preference on record"

`question-destination.ts` chooses the direct room on one condition: `steps[n].sensitive`. The other
condition outcome 2 allows — a standing preference of the person being asked — has nowhere to be
recorded. A preference is written through `auth/preference-changes.ts`, which keys every write on a
member of `preferenceChangeFields` in `db/schema-agent-selves.ts`, so recording one means:

- a `clarify_in_dm` column on `user_preferences` (`db/schema.ts`);
- `'clarify_in_dm'` in `preferenceChangeFields` (`db/schema-agent-selves.ts`);
- the field on `AssistantPreferencePatch` and `FIELD_OF` (`auth/preference-changes.ts`);
- the field on the `forge_preferences` tool's schema (`assistant/tools/forge-preferences-tool.ts`);
- one more disjunct on `wantsDirect` in `question-destination.ts`.

ISS-1091 did not make those edits because `db/schema-agent-selves.ts` was being written at the same
hour by a live run on ISS-1087 and ISS-1088, and two sessions writing one file is how a branch gets
half-reverted. It is five small edits on a quiet tree and needs no design.

## 2. "A private fact carried into a public answer requires the asker's permission, asked in the DM"

This one is not an edit that was deferred; it is a rule nothing in core can enforce, and saying so
is more useful than a ticket that implies otherwise.

Core delivers a round and reads an answer back. It cannot detect a private fact inside a screened
reply, and the judgement of what to carry from a direct answer into the public one belongs to the
agent composing that reply. What ISS-1091 delivered is the half core CAN own: the direct room is an
addressable destination, and a round marked `sensitive` on a question already threaded there stays
there — so the permission round is askable, privately, as an ordinary follow-up.

## Honest costs

- **Adopting (1)** costs five edits and a migration, and buys the second trigger outcome 2 names. It
  also costs an account-page control nobody has asked for yet: a preference the assistant can set
  and the person cannot see is one they cannot undo, which is the property `preference_changes` was
  built to avoid.
- **Adopting (2)** as a core rule costs a classifier deciding, in public, whether a thing is private
  — which is the failure `sensitive` being declared by the asker exists to prevent. The cheaper
  route is prompt-side: tell the composing agent to ask before it carries. That is a forge-plugin
  change and not one here.
- **Leaving both** costs what it costs today: a private clarification is available only to an agent
  that marks its own round, and a person who would always prefer a DM has to be marked each time.
