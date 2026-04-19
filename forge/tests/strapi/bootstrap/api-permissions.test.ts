import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seedApiPermissions, apiPermissions, pluginPermissions } from '../../../strapi/src/bootstrap/seeds/api-permissions';

const TOTAL_PERMISSIONS = apiPermissions.reduce((sum, p) => sum + p.actions.length, 0) + pluginPermissions.length;

describe('seedApiPermissions', () => {
  let mockRoleFindOne: ReturnType<typeof vi.fn>;
  let mockPermFindOne: ReturnType<typeof vi.fn>;
  let mockPermCreate: ReturnType<typeof vi.fn>;
  let mockStrapi: any;

  beforeEach(() => {
    mockRoleFindOne = vi.fn();
    mockPermFindOne = vi.fn();
    mockPermCreate = vi.fn().mockResolvedValue({});

    mockStrapi = {
      db: {
        query: vi.fn((uid: string) => {
          if (uid === 'plugin::users-permissions.role') {
            return { findOne: mockRoleFindOne };
          }
          if (uid === 'plugin::users-permissions.permission') {
            return { findOne: mockPermFindOne, create: mockPermCreate };
          }
          return {};
        }),
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
  });

  it('skips seeding when Authenticated role not found', async () => {
    mockRoleFindOne.mockResolvedValue(null);

    await seedApiPermissions(mockStrapi);

    expect(mockStrapi.log.warn).toHaveBeenCalledWith(
      'Authenticated role not found, skipping permission seed'
    );
    expect(mockPermCreate).not.toHaveBeenCalled();
  });

  it('creates all permissions when none exist', async () => {
    mockRoleFindOne.mockResolvedValue({ id: 1, type: 'authenticated' });
    mockPermFindOne.mockResolvedValue(null); // none exist

    await seedApiPermissions(mockStrapi);

    expect(mockPermCreate).toHaveBeenCalledTimes(TOTAL_PERMISSIONS);
    expect(mockStrapi.log.info).toHaveBeenCalledWith(
      `Seeded ${TOTAL_PERMISSIONS} API permissions for Authenticated role`
    );
  });

  it('skips permissions that already exist', async () => {
    mockRoleFindOne.mockResolvedValue({ id: 1, type: 'authenticated' });
    // Simulate all permissions already exist
    mockPermFindOne.mockResolvedValue({ id: 99 });

    await seedApiPermissions(mockStrapi);

    expect(mockPermCreate).not.toHaveBeenCalled();
    // No log.info call since seeded count is 0
    expect(mockStrapi.log.info).not.toHaveBeenCalled();
  });

  it('creates permission with correct action format', async () => {
    mockRoleFindOne.mockResolvedValue({ id: 1, type: 'authenticated' });
    // Let only the first one be new
    let callCount = 0;
    mockPermFindOne.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? null : { id: 99 };
    });

    await seedApiPermissions(mockStrapi);

    expect(mockPermCreate).toHaveBeenCalledTimes(1);
    expect(mockPermCreate).toHaveBeenCalledWith({
      data: {
        action: 'api::project.project.find',
        role: 1,
        enabled: true,
      },
    });
  });
});
