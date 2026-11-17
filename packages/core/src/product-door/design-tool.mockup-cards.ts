// `forge_design`'s mockup cards (ISS-1251), spread into design-tool.cards.ts, which is at its line budget.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { DESIGN_TOOL_ACTIONS } from '@forge/contracts/mcp-product';

/** When a product role reaches for each mockup action (ISS-1251). */
export const MOCKUP_CARDS = {
  mockup_list: {
    purpose: 'Lists the mockups proposed on one requirement, feedback item or issue.',
    situations: [
      {
        when: 'a person asks what a screen of a requirement or feedback item will look like',
        do: 'list its mockups and open the accepted or proposed one with mockup_get',
      },
      {
        when: 'you are about to propose a mockup on an item',
        do: 'list first: a returned one is answered by its next revision, not by a new mockup',
      },
    ],
    practice: ['Name exactly one of requirement, feedback or issue; prefer the requirement.'],
    example: { projectId: '<project uuid>', requirement: 'REQ-2' },
    redFlag: 'Proposing a mockup without reading the ones already proposed on the item.',
    family: 'design',
    audience: ['person'],
  },
  mockup_get: {
    purpose: 'Reads one mockup (MK-n): its kind, caption, status and content url.',
    situations: [
      {
        when: 'a person names a mockup, or asks what one shows or whether it was accepted',
        do: 'get it by its key and tell them its status and caption, with the item it shapes',
      },
    ],
    practice: ['Its comments are mockup_comments’; its content is at the url it names.'],
    example: { projectId: '<project uuid>', mockup: 'MK-3' },
    // forge: all 6 reads refused (the log keeps no code)
    redFlag: 'Reading a mockup by a file name or url instead of its MK-n key.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a person naming a mockup, read by its MK-n key'],
  },
  mockup_comments: {
    purpose: 'Reads every comment on a mockup and its earlier revisions, and where each points.',
    situations: [
      {
        when: 'a mockup was returned and you are about to propose its next revision',
        do: 'read its comments first and settle each open one you addressed in the next revision',
      },
      {
        when: 'a person asks what was said about a mockup',
        do: 'read its comments and say each with the point or region of the frame it pins',
      },
    ],
    practice: ['A comment open on an earlier revision is still open until a revision settles it.'],
    example: { projectId: '<project uuid>', mockup: 'MK-3' },
    redFlag: 'Revising a mockup without reading the comments pinned on its earlier revisions.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a returned mockup’s comments read before its next revision'],
  },
  mockup_comment: {
    purpose: 'Comments on a mockup, optionally pinned to a point or region of its frame.',
    situations: [
      {
        when: 'a person reacts to part of a mockup, such as a button in the wrong place',
        do: 'comment with their words, pinned to that point or region of the frame',
      },
    ],
    practice: [
      'A pin is fractions 0..1 of the frame: { x, y } for a point, { x, y, w, h } for a region.',
      'Comments are taken while it is proposed, or returned with no next revision.',
    ],
    example: {
      projectId: '<project uuid>',
      mockup: 'MK-3',
      body: {
        body: 'The reorder button should sit under the order total.',
        pin: { x: 0.7, y: 0.4 },
      },
    },
    // forge: 5 of 8 comments refused, among them on closed mockups (MOCKUP_COMMENT_CLOSED)
    redFlag: 'Commenting on a mockup already decided, where a new revision is the place.',
    family: 'design',
    audience: ['person'],
    scenarios: ['comments on a closed mockup: MOCKUP_COMMENT_CLOSED'],
  },
  mockup_propose: {
    purpose: 'Proposes a screen or call (MK-n) on the item it shapes, for a person to try.',
    situations: [
      {
        when: 'a requirement, feedback item or issue is about a screen, and words will not settle how it looks or behaves',
        do: 'propose a mockup on that item before the screen is built, so the person agrees on it, not on code',
      },
      {
        when: 'a mockup you proposed was returned',
        do: 'read its comments, then propose again with revises MK-n, settling each comment in answers or resolves',
      },
    ],
    practice: [
      'An html mockup is one self-contained file: inline CSS, scripts and data: images; only Google Fonts and cdnjs, jsdelivr or unpkg load.',
      'Send exactly one of contentBase64 with name, document (a wireframe board) or source (an upload).',
    ],
    example: {
      projectId: '<project uuid>',
      body: {
        target: { requirement: 'REQ-2' },
        kind: 'html',
        caption: 'Reorder from a past order',
        name: 'reorder.html',
        mime: 'text/html',
        contentBase64: 'PCFkb2N0eXBlIGh0bWw+',
      },
    },
    // ISS-78: every mockup discussed with the owner lived in ~/forge-local-docs/*.html, outside the item it shaped
    redFlag:
      'Building the mockup as a local file, pasting it in a chat, or publishing it elsewhere: nobody can find, comment on or pin it.',
    family: 'design',
    audience: ['person'],
    scenarios: ['mockups kept in local html outside the item they shaped: ISS-78'],
  },
  mockup_accept: {
    purpose: 'Accepts a proposed mockup as what the screen should be.',
    situations: [
      {
        when: 'a person tried a mockup and agrees with it',
        do: 'accept it with their reason; an accepted requirement mockup is pinned by the requirement’s next agree or re-pin',
      },
    ],
    practice: ['It needs mockups.approve; build jobs on its issues are then given it.'],
    example: {
      projectId: '<project uuid>',
      mockup: 'MK-3',
      reason: 'The owner agreed.',
    },
    redFlag: 'Accepting a mockup the person has not tried.',
    family: 'design',
    audience: ['person'],
  },
  mockup_return: {
    purpose: 'Returns a proposed mockup with the reason its next revision must answer.',
    situations: [
      {
        when: 'a person tried a mockup and wants it changed',
        do: 'comment on the parts they named, then return it with a reason saying what the next revision must change',
      },
    ],
    practice: ['A decided mockup stays decided: the change comes as its next revision.'],
    example: {
      projectId: '<project uuid>',
      mockup: 'MK-3',
      reason: 'Out-of-stock items must show before the cart fills.',
    },
    redFlag: 'Returning a mockup with no reason its next revision can answer.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a tried mockup returned with what its next revision must change'],
  },
  mockup_withdraw: {
    purpose: 'Takes back a mockup its author proposed, while it still waits.',
    situations: [
      {
        when: 'a mockup you proposed is wrong or no longer needed, and nobody has decided it',
        do: 'withdraw it, so it stops waiting on a person',
      },
    ],
    practice: ['Only its author withdraws; anybody else returns it with a reason.'],
    example: { projectId: '<project uuid>', mockup: 'MK-3' },
    redFlag: 'Withdrawing a mockup a person already decided.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a wrong mockup withdrawn before anyone decided it'],
  },
} satisfies Record<
  Extract<(typeof DESIGN_TOOL_ACTIONS)[number], `mockup_${string}`>,
  CapabilityCardBody
>;
