/**
 * ISS-1458 (FB-856) — plain talk about the password-reset feature is not a secret: a prose label
 * followed by a word of letters leaves the scrub unchanged, so the rule no longer refuses it; a
 * value after the label still does.
 */
import { describe, expect, it } from 'vitest';
import { NO_REDACTED_SECRET } from './text-rules.js';

const refused = (text: string): boolean => NO_REDACTED_SECRET.check(text, {} as never).length > 0;

describe('NO_REDACTED_SECRET and a prose label', () => {
  it.each([
    'Chức năng quên mật khẩu: lỗi ở bước gửi email', // i18n-allow: Vietnamese prose under test
    'Luồng đặt lại mật khẩu = chưa chạy', // i18n-allow: Vietnamese prose under test
    'password reset: failing at the email step',
    'API key: missing in the config',
  ])('does not refuse %s', (text) => {
    expect(refused(text)).toBe(false);
  });

  const values = [
    'mật khẩu: Abc12345!', // i18n-allow: the Vietnamese label under test
    'mat khau: s3cret',
    'api key: abc123',
  ];
  it.each(values)('still refuses %s', (text) => {
    expect(refused(text)).toBe(true);
  });
});
