// Which steward acts have an inverse door, and how a person overrides the ones that do not
// (REQ-48 BC-12). The undo door calls only an inverse this file admits: an act's stored undo is
// checked against it again before it is called, so a row can never send a person's credential to a
// door the catalogue did not name.

/** The doors an undo may call: re-propose a rejected breakdown, reopen a routed item, delete an issue comment. */
const INVERSE_DOORS: readonly RegExp[] = [
  /^POST \/api\/projects\/[0-9a-f-]{36}\/suggestions$/,
  /^POST \/api\/projects\/[0-9a-f-]{36}\/feedback\/[^/]+\/reopen$/,
  /^DELETE \/api\/comments\/[0-9a-f-]{36}$/,
];

export function isInverseDoor(door: string): boolean {
  return INVERSE_DOORS.some((re) => re.test(door));
}

/** How a person overrides an act no door undoes, by the door the act called. */
const OVERRIDES: readonly { door: RegExp; override: string }[] = [
  {
    door: /^POST \/api\/questions$/,
    override:
      'answer the question, or move its issue on with `voidQuestions` (`POST /api/issues/:id/transition`), which voids it: no door voids a question by itself',
  },
  {
    door: /^POST \/api\/projects\/[^/]+\/requirements\/[^/]+\/comments$/,
    override:
      'edit the comment (`PATCH /api/projects/:id/requirements/:req/comments/:comment`): no door deletes a requirement comment',
  },
  {
    door: /^POST \/api\/issues\/[^/]+\/transition$/,
    override:
      "move the issue yourself (`POST /api/issues/:id/transition`): park it `on_hold`, drop it, or send it on; the move is the kernel's, and no door reverses one",
  },
  {
    door: /^POST \/api\/issues\/[^/]+\/verdicts$/,
    override:
      'record your own verdict on the criterion: verdicts are insert-only, and the newest counts',
  },
  {
    door: /^PUT \/api\/projects\/[^/]+\/steward-notes\//,
    override:
      'write the note yourself (`PUT /api/projects/:id/steward-notes/:kind/:key`), which overrides it',
  },
  {
    door: /^WAKE /,
    override: 'nothing to undo: a wake only asks the master to look, and moves nothing',
  },
  {
    door: /^POST \/api\/projects\/[^/]+\/feedback\/[^/]+\/(tell-shipped|verify-ask|clarification)$/,
    override:
      'the reporter was told: answer them on the item instead; a notice once sent is not withdrawn',
  },
];

/** The sentence a refused undo names, for the act's own door. */
export function overrideOf(door: string): string {
  return (
    OVERRIDES.find((o) => o.door.test(door))?.override ??
    'act on the record yourself through its own door; this act names no inverse'
  );
}
