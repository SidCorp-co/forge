// The capability cards of the share doors (ISS-1251), beside their routes (`routes.ts`), keyed by
// the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from the share refusals (`service.ts`) and the calls these doors
// took on forge between 2026-10-17 and 2026-11-16, every one a master's.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const SHARE_REST_CARDS = {
  'POST /api/projects/:id/shares': {
    purpose: 'Shares a status report, release, message or report output with members or by link.',
    situations: [
      {
        when: 'a person asks for a report or release page they can pass on',
        do: 'share it with the members, or as a link where they need one outside Forge',
      },
    ],
    practice: [
      'A link share takes shares.public too; GET …/shares/audiences says which you hold.',
      'On a project whose data may not leave, a link is refused SHARE_EGRESS_FORBIDDEN.',
    ],
    example: {
      subjectKind: 'release',
      subjectId: '0.4.0-dev.698',
      audience: 'members',
      expiresInDays: 7,
    },
    // forge: 4 of 7 shares refused, 2 forbidden: link shares sent without reading the audiences held
    redFlag:
      'Sharing by link without reading which audiences you hold, or what the project lets leave.',
    family: 'release',
    audience: ['master'],
  },
  'POST /api/projects/:id/shares/:shareId/revoke': {
    purpose: 'Ends a share, so its link or member view stops answering.',
    situations: [
      {
        when: 'a share went to the wrong audience or is no longer wanted',
        do: 'revoke it by its id',
      },
    ],
    practice: ['One already revoked is refused SHARE_ALREADY_REVOKED.'],
    example: {},
    // forge: 3 of 6 revokes refused, one forbidden to a caller who did not make the share
    redFlag: 'Revoking another person’s share: its maker or an admin ends it.',
    family: 'release',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
