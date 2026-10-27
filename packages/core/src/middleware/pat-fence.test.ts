import { describe, expect, it } from 'vitest';
import { projectNamedBy } from './pat-fence.js';

const id = 'A417A126-7B96-4B8F-8D83-FAA1E7CCBD56';
const other = 'd1bb4907-0000-4000-8000-000000000001';

describe('the project a request names, read for the fence', () => {
  it('reads the path first, then the projectId query, then the slug header', () => {
    expect(projectNamedBy(`/api/projects/${id}/release-batches`, other, 'forge')).toEqual({
      by: 'path',
      ref: id.toLowerCase(),
    });
    expect(projectNamedBy(`/api/issues/${other}`, id, 'forge')).toEqual({
      by: 'query',
      ref: id.toLowerCase(),
    });
    expect(projectNamedBy(`/api/issues/${other}`, undefined, ' sidcorp-mail ')).toEqual({
      by: 'header',
      ref: 'sidcorp-mail',
    });
  });

  it('names no project where none is named, and never a segment that is not an id', () => {
    expect(projectNamedBy('/api/projects', undefined, undefined)).toBeNull();
    expect(projectNamedBy('/api/projects/health', 'not-an-id', '')).toBeNull();
    expect(projectNamedBy(`/api/issues/${id}`, undefined, '  ')).toBeNull();
  });
});
