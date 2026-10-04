import { describe, expect, it } from 'vitest';
import { agrees, counted } from './plural.js';

describe('counted', () => {
  it('names one thing in the singular', () => {
    expect(counted(1, 'reason')).toBe('1 reason');
  });

  it('names none and many in the plural', () => {
    expect(counted(0, 'issue')).toBe('0 issues');
    expect(counted(31, 'issue')).toBe('31 issues');
  });

  it('takes an irregular plural', () => {
    expect(counted(2, 'criterion', 'criteria')).toBe('2 criteria');
    expect(counted(1, 'criterion', 'criteria')).toBe('1 criterion');
  });
});

describe('agrees', () => {
  it('picks the verb that agrees with the count', () => {
    expect(`1 reason ${agrees(1, 'stands', 'stand')}`).toBe('1 reason stands');
    expect(`2 reasons ${agrees(2, 'stands', 'stand')}`).toBe('2 reasons stand');
    expect(agrees(0, 'has', 'have')).toBe('have');
  });
});
