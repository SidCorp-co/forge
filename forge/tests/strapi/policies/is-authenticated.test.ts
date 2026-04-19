import { describe, it, expect, vi } from 'vitest';
import { errors } from '@strapi/utils';
import isAuthenticated from '../../../strapi/src/policies/is-authenticated';

describe('is-authenticated policy', () => {
  it('returns true when user exists on state', () => {
    const ctx = { state: { user: { id: 1, username: 'admin' } } };
    expect(isAuthenticated(ctx)).toBe(true);
  });

  it('throws UnauthorizedError when no user', () => {
    const ctx = { state: {} };
    expect(() => isAuthenticated(ctx)).toThrow(errors.UnauthorizedError);
  });

  it('throws UnauthorizedError when state is undefined', () => {
    const ctx = {};
    expect(() => isAuthenticated(ctx)).toThrow(errors.UnauthorizedError);
  });

  it('throws UnauthorizedError when user is null', () => {
    const ctx = { state: { user: null } };
    expect(() => isAuthenticated(ctx)).toThrow(errors.UnauthorizedError);
  });
});
