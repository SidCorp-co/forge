import { describe, expect, it } from 'vitest';
import { type WedgeWordsHop, wedgeWordsFor } from './wedge-words.js';

const HOPS: WedgeWordsHop[] = ['ack', 'claim', 'heartbeat', 'result', 'dispatch'];
const ENTITIES = ['job', 'session', 'run', 'outbox', 'capacity', 'runner'];
const JARGON = /pipeline wedge|\bhop\b|loop-miss|axis|claudeSessionId|forge_jobs/i;
const LABELS = /\b(WHERE|WHY|WHAT)\b/;

describe('a stuck-work notice in plain words (ISS-1228)', () => {
  it.each(HOPS.flatMap((hop) => ENTITIES.map((entity) => [hop, entity] as const)))(
    'says %s on a %s in sentences a person reads',
    (hop, entity) => {
      const words = wedgeWordsFor(hop, entity);
      expect(words.title).not.toMatch(JARGON);
      expect(words.body).not.toMatch(JARGON);
      expect(`${words.title} ${words.body}`).not.toMatch(LABELS);
      expect(words.title).toMatch(/^[A-Z]/);
      expect(words.body).toMatch(/^[A-Z].*\.$/);
    },
  );

  it('names the session the queue timeout ended as a session no box started', () => {
    expect(wedgeWordsFor('claim', 'session').title).toBe('No box started a session it was given');
  });

  it('says what it could not tell where it has no words for the pair', () => {
    expect(wedgeWordsFor('ack', 'outbox').title).toBe('Work has stopped moving');
  });
});
