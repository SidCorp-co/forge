import { describe, expect, it } from 'vitest';
import { issueTriageOf } from './effects.js';

describe('a triage suggestion on an issue (decision on ISS-58)', () => {
  it('applies priority, category and complexity, and nothing else', () => {
    const out = issueTriageOf(
      { priority: 'high', category: 'bug', complexity: 's', note: 'crashes on save' },
      'sg-1',
    );
    expect(out.set).toEqual({ priority: 'high', category: 'bug', complexity: 's' });
    expect(out.routeNote).toBeNull();
  });

  it('applies only the fields it names', () => {
    expect(issueTriageOf({ complexity: 'xl', note: 'n' }, 'sg-1').set).toEqual({
      complexity: 'xl',
    });
    expect(issueTriageOf({ note: 'n' }, 'sg-1').set).toEqual({});
  });

  it('turns its route into a note comment carrying the suggestion and its reasoning, not into a field', () => {
    const out = issueTriageOf({ route: 'master', note: 'route it' }, 'sg-9');
    expect(out.set).toEqual({});
    expect(out.routeNote).toBe('Triage route (suggestion sg-9): master\n\nroute it');
  });
});
