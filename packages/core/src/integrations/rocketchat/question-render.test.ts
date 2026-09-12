// The message a parked question becomes, and the only reply grammar it accepts.

import { describe, expect, it } from 'vitest';
import type { QuestionOption, QuestionStep } from '../../db/schema-questions.js';
import {
  AMBIGUOUS_ROUND_REPLY,
  ANSWER_RECORDED,
  agentAuthoredSegments,
  optionToken,
  parseChoice,
  renderOptionsAgain,
  renderRound,
} from './question-render.js';

const option = (over: Partial<QuestionOption> = {}): QuestionOption => ({
  id: 'opt-1',
  label: 'Take the safe path',
  authority: 'writer',
  bindsTo: 'session',
  executedBy: 'agent',
  ...over,
});

const step = (over: Partial<QuestionStep> = {}): QuestionStep => ({
  round: 1,
  prompt: 'The migration drops a column. Which way?',
  options: [option(), option({ id: 'opt-2', label: 'Drop it' })],
  recommendedOptionId: 'opt-1',
  askedAt: new Date('2026-09-12T00:00:00Z').toISOString(),
  ...over,
});

describe('renderRound', () => {
  it('names the issue, the prompt, every option, the recommended one and the deadline', () => {
    const text = renderRound({
      issueKey: 'ISS-978',
      step: step(),
      rounds: 1,
      parkDeadlineAt: new Date('2026-09-13T10:00:00Z'),
    });
    expect(text).toContain('ISS-978');
    expect(text).toContain('The migration drops a column. Which way?');
    expect(text).toContain('1. Take the safe path');
    expect(text).toContain('2. Drop it');
    expect(text.split('\n').find((l) => l.startsWith('1.'))).toContain('recommended');
    expect(text.split('\n').find((l) => l.startsWith('2.'))).not.toContain('recommended');
    expect(text).toContain('2026-09-13T10:00:00.000Z');
  });

  it('says what happens when nobody answers and no deadline was set', () => {
    const text = renderRound({ issueKey: null, step: step(), rounds: 1, parkDeadlineAt: null });
    expect(text).toContain('the run stays parked');
  });

  it('states authority, scope, executor and the call a this_call option is fingerprinted for', () => {
    const admin = option({
      id: 'opt-2',
      label: 'Let it run',
      authority: 'admin',
      bindsTo: 'this_call',
      executedBy: 'core',
      fingerprint: 'deploy forge-beta @ 48968fda',
    });
    const text = renderRound({
      issueKey: 'ISS-978',
      step: step({ options: [option(), admin] }),
      rounds: 1,
      parkDeadlineAt: null,
    });
    const line = text.split('\n').find((l) => l.startsWith('2.')) ?? '';
    expect(line).toContain('admins only');
    expect(line).toContain('binds to this call only: deploy forge-beta @ 48968fda');
    expect(line).toContain('carried out by the core');
  });

  it('qualifies every option with its round once the question has more than one', () => {
    const text = renderRound({
      issueKey: 'ISS-978',
      step: step({ round: 2 }),
      rounds: 2,
      parkDeadlineAt: null,
    });
    expect(text).toContain('2-1. Take the safe path');
    expect(text).toContain('2-2. Drop it');
    expect(text).toContain('`2-1`');
  });
});

describe('parseChoice', () => {
  it('reads a bare number while the question has exactly one round', () => {
    expect(parseChoice('2', 1)).toEqual({ ok: true, round: 1, index: 1 });
    expect(parseChoice('  2. ', 1)).toEqual({ ok: true, round: 1, index: 1 });
  });

  it('refuses a bare number as ambiguous once a second round exists', () => {
    expect(parseChoice('2', 2)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('reads a round-qualified token at any number of rounds', () => {
    expect(parseChoice('1-2', 3)).toEqual({ ok: true, round: 1, index: 1 });
    expect(parseChoice('3-1', 3)).toEqual({ ok: true, round: 3, index: 0 });
  });

  it('reads no option out of prose, a label, or a number inside a sentence', () => {
    expect(parseChoice('the safe path please', 1).ok).toBe(false);
    expect(parseChoice('Take the safe path', 1).ok).toBe(false);
    expect(parseChoice('I pick 2', 1).ok).toBe(false);
    expect(parseChoice('0', 1).ok).toBe(false);
    expect(parseChoice('', 1).ok).toBe(false);
  });
});

describe('the fixed bodies', () => {
  it('re-posts the options rather than naming one, when a reply matched nothing', () => {
    const again = renderOptionsAgain(step(), 1);
    expect(again).toContain('1. Take the safe path');
    expect(again).toContain('2. Drop it');
    expect(again).not.toContain('recommended');
  });

  it('tells the ambiguous answerer to name the round', () => {
    expect(AMBIGUOUS_ROUND_REPLY).toContain('2-1');
  });

  it('reports a Rocket.Chat handle, and refuses to interpolate anything else', () => {
    expect(ANSWER_RECORDED('1', 'sid.corp', 'user-1')).toContain('@sid.corp');
    const hostile = ANSWER_RECORDED('1', '@all everybody look', 'user-1');
    expect(hostile).not.toContain('@all');
    expect(hostile).toContain('user-1');
  });

  it('hands the screen every string the agent wrote and nothing the code wrote', () => {
    expect(agentAuthoredSegments(step())).toEqual([
      'The migration drops a column. Which way?',
      'Take the safe path',
      'Drop it',
    ]);
  });
});

describe('optionToken', () => {
  it('is bare at one round and round-qualified beyond it', () => {
    expect(optionToken(1, 0, 1)).toBe('1');
    expect(optionToken(2, 0, 2)).toBe('2-1');
  });
});
