// ISS-857 (owner ruling agent-is-the-voice): a reporter's bell notice is the kernel fact — key, phase,
// version, the item's title — and words a person or an agent wrote. Core composes no sentence, and the
// canned confirm-or-reopen ask is gone: verify and reopen stay as the item's actions.
import { describe, expect, it } from 'vitest';
import {
  declinedNotice,
  duplicateNotice,
  messageNotice,
  shippedNotice,
  stepNotice,
  verifyAskNotice,
} from './reporter-notices.js';

// a sentence core would have composed: a capital, words, and a full stop or an imperative ask
const CORE_SENTENCE =
  /confirm|reopen it|verify the fix|will not be done|was merged|you will hear|on your behalf|goes back|carries the work|has shipped|is routed|reason:/i;

describe('reporter notices carry the kernel fact and no core-composed sentence', () => {
  it('a shipped item: key · shipped · version · title, and only the release notes as body', () => {
    const n = shippedNotice(
      'FB-4',
      'Export breaks',
      '0.4.1',
      ['Saving the board keeps every card.'],
      null,
    );
    expect(n).toEqual({
      title: 'FB-4 · shipped · 0.4.1 · Export breaks',
      body: 'Saving the board keeps every card.',
    });
  });

  it('a shipped item with no release and no note: the fact alone, an empty body, no ask', () => {
    const n = shippedNotice('FB-4', 'Export breaks', null, [], null);
    expect(n).toEqual({ title: 'FB-4 · shipped · Export breaks', body: '' });
  });

  it("a shipped item's evidence is the criterion and its verdict, and the clip's name", () => {
    const n = shippedNotice('FB-4', 'Export breaks', '0.4.1', [], {
      criterion: 'REQ-3 BC-2',
      verdict: 'passing',
      why: null,
      clip: { name: 'export.webm', mime: 'video/webm', url: '/x' },
      reads: '',
      says: { reads: { text: '' } } as never,
    });
    expect(n.body).toBe('REQ-3 BC-2 · passing\nclip · export.webm');
    const notYet = shippedNotice('FB-4', 'Export breaks', '0.4.1', [], {
      criterion: 'REQ-3 BC-2',
      verdict: 'not_judged',
      why: 'nobody judged it yet',
      clip: null,
      reads: '',
      says: { reads: { text: '' } } as never,
    });
    expect(notYet.body).toBe('REQ-3 BC-2 · not passing');
  });

  it('a declined item carries the triager reason as written, and nothing core wrote', () => {
    expect(declinedNotice('FB-2', 'Blue board', ' Brand guide. ')).toEqual({
      title: 'FB-2 · declined · Blue board',
      body: 'Brand guide.',
    });
  });

  it('a duplicate names the original it went to, and nothing else', () => {
    expect(duplicateNotice('FB-3', 'Slow export', 'FB-1')).toEqual({
      title: 'FB-3 · duplicate of FB-1 · Slow export',
      body: '',
    });
  });

  it("a triager's message is delivered as written under the fact", () => {
    expect(messageNotice('FB-2', 'Blue board', '  Hello.  ')).toEqual({
      title: 'FB-2 · message · Blue board',
      body: 'Hello.',
    });
  });

  it('a step names the move and its carrier, with no sentence', () => {
    expect(stepNotice('triaged', 'FB-2', 'Blue board', 'ISS-5')).toEqual({
      title: 'FB-2 · triaged to ISS-5 · Blue board',
      body: '',
    });
    expect(stepNotice('triaged', 'FB-2', 'Blue board', null).title).toBe(
      'FB-2 · triaged · Blue board',
    );
    expect(stepNotice('verified', 'FB-2', 'Blue board')).toEqual({
      title: 'FB-2 · verified · Blue board',
      body: '',
    });
    expect(stepNotice('reopened', 'FB-2', 'Blue board')).toEqual({
      title: 'FB-2 · reopened · Blue board',
      body: '',
    });
  });

  it('the verify ask is the resolved fact: no canned confirm-or-reopen text', () => {
    expect(verifyAskNotice('FB-4', 'Export breaks')).toEqual({
      title: 'FB-4 · resolved · Export breaks',
      body: '',
    });
  });

  it('no notice carries a core-composed sentence', () => {
    const all = [
      shippedNotice('FB-1', 't', '1.0.0', [], null),
      shippedNotice('FB-1', 't', null, [], null),
      declinedNotice('FB-1', 't', ''),
      duplicateNotice('FB-1', 't', 'FB-0'),
      messageNotice('FB-1', 't', 'x'),
      stepNotice('triaged', 'FB-1', 't', null),
      stepNotice('verified', 'FB-1', 't'),
      stepNotice('reopened', 'FB-1', 't'),
      verifyAskNotice('FB-1', 't'),
    ];
    for (const n of all) {
      expect(`${n.title}\n${n.body}`).not.toMatch(CORE_SENTENCE);
    }
  });
});
