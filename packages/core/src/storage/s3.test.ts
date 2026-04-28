import { describe, expect, it } from 'vitest';
import { S3Storage } from './s3.js';

describe('S3Storage stub', () => {
  const s = new S3Storage('bucket', 'us-east-1');

  it('throws on put with a clear message', async () => {
    await expect(s.put('k', Buffer.from('x'), 'text/plain')).rejects.toThrow(/not implemented/i);
  });

  it('throws on get with a clear message', async () => {
    await expect(s.get('s3://bucket/k')).rejects.toThrow(/not implemented/i);
  });

  it('preserves bucket and region for future implementation', () => {
    expect(s.bucket).toBe('bucket');
    expect(s.region).toBe('us-east-1');
  });
});
