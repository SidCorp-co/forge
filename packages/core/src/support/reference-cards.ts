// The capability cards of a room agent's reference acts (ISS-1252; owner 2026-11-16: he adds a source
// in plain words to the agent he talks to, and that agent records it; bots consult sources first).
// They are the one teaching of these acts for a room agent: the references door's own cards
// (`@forge/contracts/references:REFERENCE_CARDS`) teach masters and runs, never the bot, so the act
// is taught once per audience. No red flag is written until a misuse is seen.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

const THREAD = '86aGqsokzYezYNdvF';

export const REFERENCE_ACT_CARDS = {
  references: {
    purpose:
      'Reads the reference sources a project learns from first, by area or topic: repositories, products and docs, each with why.',
    situations: [
      {
        when: 'you face a design question or a defect with no settled answer in the project',
        do: 'read its reference sources first with support.references { project, area or q }, then the source itself, and cite what you used with support.reference_cite',
      },
    ],
    practice: [
      'Search by the area you work in first, then by topic words; never research the open web from zero while the project names sources it trusts.',
      'Name the file, doc or release you used in your answer, and say what you take and what you reject.',
    ],
    example: { project: 'epod', area: 'theme' },
    audience: ['bot'],
  },
  reference_add: {
    purpose:
      'Adds the source a person tells you to follow or learn from, as their own add, under their Forge permission.',
    situations: [
      {
        when: 'the owner says to follow or learn from a repo, product or doc for some area (“follow X for Y”)',
        do: 'support.reference_add citing his message, with its address, why in his words and the areas, and followReleases where it ships releases',
        watch: 'tell him it is added; never send him to a screen to add it himself',
      },
    ],
    practice: [
      'It runs as the writer of the message you cite: a member who may not add one is refused, so propose theirs with support.reference_propose.',
      'Only a github.com repository’s releases are followed; add another unfollowed.',
    ],
    example: {
      thread: THREAD,
      message: 'pX4cQe9TnB2wLs7Rk',
      project: 'epod',
      kind: 'repo',
      url: 'https://github.com/stablyai/orca',
      why: 'parallel CLI agents in isolated git worktrees',
      areas: ['worktrees'],
      followReleases: true,
    },
    audience: ['bot'],
  },
  reference_cite: {
    purpose:
      'Records one use of a reference source: what you read, whether you took or rejected it, and why.',
    situations: [
      {
        when: 'you used a reference source in an answer, a fix or a design',
        do: 'support.reference_cite { source, ref, verdict, why } naming the file, doc or release you read, and the work it was for as about',
      },
    ],
    practice: [
      'One citation per decision; a reject teaches as much as a take, so say why that path was not followed.',
    ],
    example: {
      project: 'epod',
      source: 'stablyai/orca',
      ref: 'src/worktrees/create.ts',
      verdict: 'take',
      why: 'one worktree per task under the repo, removed when the task lands',
      about: 'ISS-167',
    },
    audience: ['bot'],
  },
  reference_propose: {
    purpose:
      'Proposes a source you kept using that the project does not list, recorded as yours with the work it helped.',
    situations: [
      {
        when: 'you used the same outside source on several pieces of work and the project does not list it, or a member suggests one',
        do: 'support.reference_propose with its address, why, areas, and as evidence the work it helped and what you took',
      },
    ],
    practice: ['A source earns its place by repeated use, never a page read once.'],
    example: {
      project: 'epod',
      kind: 'doc',
      url: 'https://shopify.dev/docs/storefronts/themes/architecture',
      why: 'how a theme’s sections and blocks are laid out',
      areas: ['theme'],
      evidence: 'ISS-160 and ISS-167 took its section schema layout',
    },
    audience: ['bot'],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
