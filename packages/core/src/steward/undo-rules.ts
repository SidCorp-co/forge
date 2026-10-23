// Which steward acts have an inverse door, and how a person overrides the ones that do not
// (REQ-48 BC-12). The undo door calls only an inverse this file admits: an act's stored undo is
// checked against it again before it is called, so a row can never send a person's credential to a
// door the catalogue did not name.

/**
 * The doors an undo may call: re-propose a rejected breakdown, reopen a routed item, delete an issue
 * comment or a requirement comment, void a question, and set a requirement's owner back.
 */
const INVERSE_DOORS: readonly RegExp[] = [
  /^POST \/api\/projects\/[0-9a-f-]{36}\/suggestions$/,
  /^POST \/api\/projects\/[0-9a-f-]{36}\/feedback\/[^/]+\/reopen$/,
  /^DELETE \/api\/comments\/[0-9a-f-]{36}$/,
  /^DELETE \/api\/projects\/[0-9a-f-]{36}\/requirements\/REQ-\d+\/comments\/[0-9a-f-]{36}$/,
  /^POST \/api\/questions\/[0-9a-f-]{36}\/void$/,
  /^PATCH \/api\/projects\/[0-9a-f-]{36}\/requirements\/REQ-\d+$/,
  /^DELETE \/api\/projects\/[0-9a-f-]{36}\/requirements\/REQ-\d+\/issues\/[0-9a-f-]{36}$/,
  /^PATCH \/api\/issues\/[0-9a-f-]{36}$/,
  /^PUT \/api\/issues\/[0-9a-f-]{36}\/criteria$/,
];

export function isInverseDoor(door: string): boolean {
  return INVERSE_DOORS.some((re) => re.test(door));
}

/**
 * How a person overrides an act no door undoes, by the door the act called: `override` for the
 * refusal a caller of the undo door reads, `person` for the item page's Activity, which names no route.
 */
const OVERRIDES: readonly { door: RegExp; override: string; person: string }[] = [
  {
    door: /^POST \/api\/issues\/[^/]+\/transition$/,
    override:
      "move the issue yourself (`POST /api/issues/:id/transition`): park it `on_hold`, drop it, or send it on; the move is the kernel's, and no door reverses one",
    person: 'Move the issue yourself: put it on hold, drop it, or send it on.',
  },
  {
    door: /^POST \/api\/issues\/[^/]+\/verdicts$/,
    override:
      'record your own verdict on the criterion: verdicts are insert-only, and the newest counts',
    person: 'Record your own verdict on the criterion; the newest one counts.',
  },
  {
    door: /^PUT \/api\/projects\/[^/]+\/steward-notes\//,
    override:
      'write the note yourself (`PUT /api/projects/:id/steward-notes/:kind/:key`), which overrides it',
    person: 'Write the note yourself; yours replaces it.',
  },
  {
    door: /^POST \/api\/projects\/[^/]+\/lessons\/[^/]+\/confusions$/,
    override:
      "nothing to undo: the steward's lessons pass settles the confusion (keep, edit or retire the lesson) on its next pass, and keeping the lesson takes it off hold",
    person: 'Nothing to undo: the steward settles the lesson on its next pass.',
  },
  {
    door: /^POST \/api\/projects\/[^/]+\/requirements$/,
    override:
      'withdraw the requirement yourself on its page: it was started as a draft from the feedback, and its intake is yours to carry or stop',
    person: 'Withdraw the requirement on its own page.',
  },
  {
    door: /^KEEP /,
    override:
      'nothing to undo: a keep moved nothing, and the steward asks again once the standing moves; to decide now, act on the item yourself through its own door',
    person: 'Nothing to undo: a keep moved nothing. Act on the item yourself to decide now.',
  },
  {
    door: /^WAKE /,
    override: 'nothing to undo: a wake only asks the master to look, and moves nothing',
    person: 'Nothing to undo: a wake only asks the master to look.',
  },
  {
    door: /^NOTIFY /,
    override:
      'nothing to undo: the release holders were told, and a notice once sent is not withdrawn; decide the release on its own page',
    person: 'The release holders were told. Decide the release on its page.',
  },
  {
    door: /^POST \/api\/projects\/[^/]+\/feedback\/[^/]+\/(tell-shipped|verify-ask|clarification)$/,
    override:
      'the reporter was told: answer them on the item instead; a notice once sent is not withdrawn',
    person: 'The reporter was told. Answer them on the item instead.',
  },
];

const NO_INVERSE = {
  override: 'act on the record yourself through its own door; this act names no inverse',
  person: 'Act on the record yourself; this act has no undo.',
};

/** How a person overrides the act on its item's page, for an act no door undoes (REQ-48 BC-12). */
export function personOverrideOf(door: string): string {
  return (OVERRIDES.find((o) => o.door.test(door)) ?? NO_INVERSE).person;
}

/** The sentence a refused undo names, for the act's own door. */
export function overrideOf(door: string): string {
  return (OVERRIDES.find((o) => o.door.test(door)) ?? NO_INVERSE).override;
}
