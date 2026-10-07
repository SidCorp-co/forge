import { notLiveSentence } from '@forge/contracts/contract-waits';
import { sayEn } from '@forge/contracts/said';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { contractWaitUnsettledSql } from '../../db/schema-contract-waits.js';
import { contractWaitUnsettled, heldTakeRefusal } from '../../issues/index.js';
import { liveOf } from '../../runs/standing-live.js';
import type { RunFacts, StandingContext } from '../../runs/standing-types.js';
import { providerLiveMode } from './waits-live.js';

const held = contractWaitUnsettled([
  { issue: 'HOP-7', contract: 'acme/orders', minVersion: '2.0.0' },
]);

describe('the contract wait gate', () => {
  it('refuses a held take by name, naming the contract and the version it waits on', () => {
    const refusal = heldTakeRefusal(held);
    expect(refusal?.refusals[0]?.code).toBe('CONTRACT_WAIT_UNSETTLED');
    expect(refusal?.refusals[0]?.detail).toContain('HOP-7 waits on acme/orders >= 2.0.0');
  });

  it('holds only a live wait no approved version settled', () => {
    const text = new PgDialect().sqlToQuery(contractWaitUnsettledSql(sql`i.id`)).sql;
    expect(text).toContain('cw.retracted_at IS NULL');
    expect(text).toContain('cw.settled_at IS NULL');
  });

  it('names a queued job held by a contract wait as waiting on a gate, never as queued for the master', () => {
    const at = new Date('2026-10-05T00:00:00Z');
    const facts = {
      run: { status: 'running', startedAt: at, updatedAt: at, pauseReason: null },
      issue: null,
      session: null,
      job: {
        id: 'j1',
        status: 'queued',
        heldBy: null,
        hold: null,
        retryAfterAt: null,
        queuedAt: at,
      },
      ledger: null,
      question: null,
      approval: null,
      master: null,
    } as unknown as RunFacts;
    const ctx = {
      now: at,
      viewer: null,
      slots: null,
      queuedGates: new Map([['j1', 'contract_wait_unsettled']]),
    } as unknown as StandingContext;
    const d = liveOf(facts, ctx);
    expect(d.state).toBe('waiting_gate');
    expect(sayEn(d.rule)).toContain('CONTRACT_WAIT_UNSETTLED');
  });
});

describe('the provider live gate (E4)', () => {
  it('is on unless every shared ecosystem turned it off', () => {
    expect(providerLiveMode([])).toBe('required');
    expect(providerLiveMode([undefined])).toBe('required');
    expect(providerLiveMode(['off', 'required'])).toBe('required');
    expect(providerLiveMode(['off', 'off'])).toBe('off');
  });

  it('refuses by name with the contract, the version needed and what production serves', () => {
    const s = notLiveSentence([
      {
        issueId: 'x',
        issue: 'HOP-7',
        contract: 'acme/orders',
        needed: '2.0.0',
        live: '1.4.0',
        unread: null,
      },
      {
        issueId: 'y',
        issue: 'HOP-8',
        contract: 'acme/orders',
        needed: '2.0.0',
        live: null,
        unread: 'no probe',
      },
    ]);
    expect(s).toMatch(/^CONTRACT_PROVIDER_NOT_LIVE/);
    expect(s).toContain(
      "`HOP-7` needs acme/orders >= 2.0.0, and its provider's production serves 1.4.0",
    );
    expect(s).toContain('no version Forge could place (no probe)');
  });
});
