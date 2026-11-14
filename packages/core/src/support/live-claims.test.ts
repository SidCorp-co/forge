// The words that make a live or not-live claim, as `unreadLiveClaim` polices them (ISS-1123): a
// post saying a change is live without the turn having read a release is refused. The 2026-11-08
// cleanup audit found the pattern missing the common phrasings and catching an order's state.
// @direct-test-of packages/core/src/support/live-claims.ts

import { describe, expect, it } from 'vitest';
import { liveClaimIn } from './live-claims.js';

describe('liveClaimIn', () => {
  it.each([
    "It's live now",
    'It’s live now',
    'The fix went live this morning',
    'That change shipped to production yesterday',
    'We pushed it to production',
    'The release is live',
    'ISS-12 is not yet deployed',
    'the build was released to staging',
    'it goes live tonight',
    'bản vá đã được triển khai', // i18n-allow: the Vietnamese claim being policed
  ])('reads %s as a live claim', (text) => {
    expect(liveClaimIn(text)).not.toBeNull();
  });

  it.each([
    'Your order is live',
    'order ORD-1 is live',
    'ticket 44 is live',
    'đơn hàng đã được giao', // i18n-allow: an order's state, not a deploy's
    'the live chat is open',
    'we deploy on Fridays',
  ])('reads %s as no claim of a deploy', (text) => {
    expect(liveClaimIn(text)).toBeNull();
  });
});
