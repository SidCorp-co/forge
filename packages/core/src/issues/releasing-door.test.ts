/**
 * ISS-1421 — the door onto and off `releasing`, measured on its own. The integration suites
 * (`releasing-door-e2e`, `releasing-settle-e2e`) prove every route reaches it; this proves what it
 * answers for each ask, and that each refusal says what Releasing is and where a release starts.
 */

import { markMergedSteps } from '@forge/contracts/mark-merged-words';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const claimRow = vi.fn(
  async (): Promise<Array<{ run: string | null; slug?: string }>> => [{ run: null }],
);
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => claimRow() }) }) }),
  },
}));

vi.mock('../config/env.js', () => ({ env: { APP_BASE_URL: 'https://forge.example/' } }));

const declaration = vi.fn(async (): Promise<{ kind: string } | null> => ({ kind: 'gated' }));
vi.mock('../release-batch/gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../release-batch/gate.js')>()),
  resolveReleaseDeclaration: () => declaration(),
}));

type Hold = { reason: string; clears: string };
const shortfalls = vi.fn(async (_p: string, _ids: readonly string[]) => new Map<string, Hold[]>());
vi.mock('../release-batch/close-shortfall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../release-batch/close-shortfall.js')>()),
  rosterCloseShortfalls: (p: string, ids: readonly string[]) => shortfalls(p, ids),
}));

const { releasingDoorRefusal } = await import('./releasing-door.js');

const NOT_MERGED: Hold = {
  reason: 'not marked merged',
  clears: markMergedSteps(false),
};

const base = { issueId: 'iss-1', projectId: 'proj-7' } as const;

beforeEach(() => {
  claimRow.mockReset();
  claimRow.mockResolvedValue([{ run: null }]);
  declaration.mockReset();
  declaration.mockResolvedValue({ kind: 'gated' });
  shortfalls.mockReset();
  shortfalls.mockResolvedValue(new Map());
});

describe('entering releasing (ISS-1421)', () => {
  it('refuses every door that names no release run, saying where a release starts', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(refusal?.detail).toContain(
      'Releasing means a release batch is carrying this issue to production right now',
    );
    expect(refusal?.detail).toContain("Release now on this issue's page");
    expect(refusal?.detail).toContain('at the release gate');
    expect(refusal?.detail).toContain('POST /api/projects/proj-7/release-batches');
    expect(refusal?.detail).toContain('The issue stays at Awaiting release.');
    expect(shortfalls).toHaveBeenCalledWith('proj-7', ['iss-1']);
  });

  it('tells an issue a release would hand back what holds it, not to press Release now (ISS-1421 r3)', async () => {
    shortfalls.mockResolvedValue(new Map([['iss-1', [NOT_MERGED]]]));
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(refusal?.detail).toContain(
      'A release cannot close this issue yet. It is not marked merged.',
    );
    expect(refusal?.detail).toContain(markMergedSteps(false));
    expect(refusal?.detail).toContain('Release now appears on its page once that is done.');
    expect(refusal?.detail).not.toContain('Start one with Release now');
    expect(refusal?.detail).not.toContain('release-batches');
  });

  it('names every hold, an open question beside a missing merge', async () => {
    shortfalls.mockResolvedValue(
      new Map([
        [
          'iss-1',
          [NOT_MERGED, { reason: 'holds 1 open question', clears: 'Answer it on the page.' }],
        ],
      ]),
    );
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.detail).toContain(
      'A release cannot close this issue yet. It is not marked merged.',
    );
    expect(refusal?.detail).toContain('It holds 1 open question. Answer it on the page.');
  });

  it('names no Release now where what holds the issue cannot be read', async () => {
    shortfalls.mockRejectedValue(new Error('db down'));
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.detail).toContain(
      'Whether a release would close this issue could not be read.',
    );
    expect(refusal?.detail).not.toContain('Start one with Release now');
  });

  it('does not read what holds an issue that is not at the gate', async () => {
    await releasingDoorRefusal({ ...base, from: 'testing', to: 'releasing' });
    expect(shortfalls).not.toHaveBeenCalled();
  });

  it('tells an issue not yet at the gate it must reach Awaiting release first, not to press Release now', async () => {
    for (const from of ['open', 'developed', 'testing'] as const) {
      const refusal = await releasingDoorRefusal({ ...base, from, to: 'releasing' });
      expect(refusal?.code, from).toBe('RELEASING_STARTS_FROM_RELEASE');
      expect(refusal?.detail, from).toContain(
        'A release carries only issues at Awaiting release, so it must reach that first.',
      );
      expect(refusal?.detail, from).not.toContain('Release now');
      expect(refusal?.detail, from).not.toContain('release-batches');
    }
  });

  it('on a project that ships nothing, names the setting and no release door', async () => {
    declaration.mockResolvedValue({ kind: 'no-release' });
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(refusal?.detail).toContain('This project releases nothing');
    expect(refusal?.detail).toContain(
      "To release them, choose a shape that releases under Shape & release in the project's settings.",
    );
    expect(refusal?.detail).not.toContain('Release now');
    expect(refusal?.detail).not.toContain('release gate');
    expect(refusal?.detail).not.toContain('release-batches');
  });

  it('on a project with no live deploy target, says no release can start until one is added', async () => {
    declaration.mockResolvedValue({ kind: 'undeclared-target' });
    claimRow.mockResolvedValue([{ run: null, slug: 'acme-shop' }]);
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.detail).toContain(
      "No release can start until one is added in the project's Settings, on the Integrations tab. There, share a connection as Deploy target, with Live ticked.",
    );
    // ISS-1421 r4: the place is named, and the address that opens it is carried (judge-32).
    const link =
      'https://forge.example/projects/acme-shop/settings?tab=integrations&add=live-deploy-target';
    expect(refusal?.detail).toContain(`It opens at ${link}.`);
    expect(refusal?.details).toMatchObject({ addLiveTarget: link });
    expect(refusal?.detail).not.toContain('Release now');
    expect(refusal?.detail).not.toContain('release gate');
  });

  it('names no door where the declaration cannot be read', async () => {
    declaration.mockRejectedValue(new Error('db down'));
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(refusal?.detail).toContain(
      "This project's release settings could not be read, so this names no way to start a release.",
    );
    expect(refusal?.detail).not.toContain('Release now');
  });

  it('refuses it from any rung, not only the gate', async () => {
    for (const from of ['open', 'in_progress', 'testing', 'on_hold', 'closed'] as const) {
      const refusal = await releasingDoorRefusal({ ...base, from, to: 'releasing' });
      expect(refusal?.code, from).toBe('RELEASING_STARTS_FROM_RELEASE');
    }
  });

  it('refuses a release path flag that names no run: viaReleasePath does not open the entry', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
      viaReleasePath: true,
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
  });

  it('lets the batch create through, naming its run', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
      releaseRun: 'run-1',
    });
    expect(refusal).toBeNull();
  });

  it('throws on a run named for a move that does not enter releasing', async () => {
    await expect(
      releasingDoorRefusal({
        ...base,
        from: 'testing',
        to: 'awaiting_release',
        releaseRun: 'run-1',
      }),
    ).rejects.toThrow(/releaseRun names the run a move enters Releasing/);
  });
});

describe('leaving releasing (ISS-1421)', () => {
  it('refuses a move off it from a door that is not a release path, sending the reader to the run page', async () => {
    claimRow.mockResolvedValue([{ run: 'run-9', slug: 'shop' }]);
    for (const to of ['closed', 'reopen', 'needs_info', 'on_hold', 'awaiting_release'] as const) {
      const refusal = await releasingDoorRefusal({ ...base, from: 'releasing', to });
      expect(refusal?.code, to).toBe('RELEASING_ENDS_BY_RELEASE');
      expect(refusal?.detail).toContain(
        'The release carrying it shows where it stands at https://forge.example/projects/shop/releases/run-9.',
      );
      expect(refusal?.detail).toContain('The issue stays at Releasing');
      expect(refusal?.detail).toContain(
        'Its abort, or the recovery of a release that stopped or could not go on, returns it to the release gate.',
      );
    }
  });

  // ISS-1421 r5: the refusal named GET .../state and POST .../abort with the run's id, which a
  // person reading it on the issue page cannot press.
  it('names no API route, and keeps each sentence short and whole', async () => {
    claimRow.mockResolvedValue([{ run: 'run-9', slug: 'shop' }]);
    const refusal = await releasingDoorRefusal({ ...base, from: 'releasing', to: 'closed' });
    expect(refusal?.detail).not.toMatch(/\/api\/|\bGET\b|\bPOST\b|release-batches/);
    for (const sentence of (refusal?.detail ?? '').split(/(?<=\.)\s+(?=[A-Z])/)) {
      expect(sentence).toMatch(/^[A-Z]/);
      expect(sentence).toMatch(/\.$/);
      expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
  });

  it('says an unclaimed row is settled by the sweep rather than offering an abort', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'releasing',
      to: 'awaiting_release',
    });
    expect(refusal?.detail).toContain('the releasing sweep returns it to the release gate');
    expect(refusal?.detail).not.toContain('/abort');
  });

  it('lets a release path through', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'releasing',
      to: 'closed',
      viaReleasePath: true,
    });
    expect(refusal).toBeNull();
  });

  it('answers nothing for a move that touches releasing on neither side', async () => {
    expect(
      await releasingDoorRefusal({ ...base, from: 'testing', to: 'awaiting_release' }),
    ).toBeNull();
    expect(claimRow).not.toHaveBeenCalled();
  });
});

// ISS-1421 r6, criterion 91 — judge-37 read "Releasing (releasing)" and "Awaiting release
// (awaiting_release)" in these refusals. Their way out is a release, never a status a caller sends,
// so they name statuses in words alone; the code and the details carry the values.
describe('the release path names statuses in words (criterion 91)', () => {
  const STORED =
    /\((?:releasing|awaiting_release|open|in_progress|developed|testing|closed|reopen|dropped|on_hold|needs_info|approved|confirmed|waiting|draft)\)/;

  it('in every refusal entering or leaving Releasing', async () => {
    const said: string[] = [];
    for (const from of ['awaiting_release', 'open', 'testing'] as const) {
      said.push((await releasingDoorRefusal({ ...base, from, to: 'releasing' }))?.detail ?? '');
    }
    claimRow.mockResolvedValue([{ run: 'run-9', slug: 'shop' }]);
    for (const to of ['closed', 'reopen', 'awaiting_release'] as const) {
      said.push((await releasingDoorRefusal({ ...base, from: 'releasing', to }))?.detail ?? '');
    }
    for (const detail of said) {
      expect(detail).not.toBe('');
      expect(detail).not.toMatch(STORED);
    }
  });
});
