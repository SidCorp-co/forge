/**
 * ISS-987 — the room half of the three shapes. The mapper is pure; the resolver
 * is covered for the two things a caller depends on and cannot see: that an
 * unreadable or unknown room type yields null rather than a guessed shape, and
 * that a resolved room is not asked about twice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRoomType = vi.fn();
vi.mock('./rest-client.js', () => ({
  fetchRoomType: (...args: unknown[]) => fetchRoomType(...args),
}));

const { clearRoomShapeCache, resolveRoomShape, roomShapeFromType } = await import(
  './room-shape.js'
);

const AUTH = { serverUrl: 'https://chat.example.co', authToken: 't', userId: 'bot' };

describe('roomShapeFromType', () => {
  it('reads a direct room', () => {
    expect(roomShapeFromType('d')).toBe('direct');
  });

  it('reads a channel and a private group as one shape', () => {
    expect(roomShapeFromType('c')).toBe('group');
    expect(roomShapeFromType('p')).toBe('group');
  });

  it('refuses a type it does not know rather than picking a side', () => {
    expect(roomShapeFromType('l')).toBeNull();
    expect(roomShapeFromType('')).toBeNull();
    expect(roomShapeFromType('D')).toBeNull();
  });
});

describe('resolveRoomShape', () => {
  beforeEach(() => {
    fetchRoomType.mockReset();
    clearRoomShapeCache();
  });

  it('resolves the shape from the room type', async () => {
    fetchRoomType.mockResolvedValue('d');
    expect(await resolveRoomShape(AUTH, 'room-1')).toBe('direct');
  });

  it('answers null when the room type cannot be read', async () => {
    fetchRoomType.mockResolvedValue(null);
    expect(await resolveRoomShape(AUTH, 'room-1')).toBeNull();
  });

  it('answers null for a room type no shape covers', async () => {
    fetchRoomType.mockResolvedValue('l');
    expect(await resolveRoomShape(AUTH, 'room-1')).toBeNull();
  });

  it('asks once per room and reads the answer back from the cache', async () => {
    fetchRoomType.mockResolvedValue('c');

    expect(await resolveRoomShape(AUTH, 'room-1')).toBe('group');
    expect(await resolveRoomShape(AUTH, 'room-1')).toBe('group');

    expect(fetchRoomType).toHaveBeenCalledTimes(1);
  });

  it('asks again for a room it has not resolved', async () => {
    fetchRoomType.mockResolvedValue('c');

    await resolveRoomShape(AUTH, 'room-1');
    await resolveRoomShape(AUTH, 'room-2');

    expect(fetchRoomType).toHaveBeenCalledTimes(2);
  });

  // cm:why one installation's room id may not answer for another's: the same rid on a second Rocket.Chat server is a different room, and a rid-only cache would hand it the first server's shape — which decides whether a mention is required (same rule as `assistant_speaker_links.external_namespace`)
  it('does not let one server answer for another server room of the same id', async () => {
    fetchRoomType.mockResolvedValueOnce('d').mockResolvedValueOnce('c');

    const first = await resolveRoomShape(AUTH, 'room-1');
    const second = await resolveRoomShape(
      { ...AUTH, serverUrl: 'https://other.example.co' },
      'room-1',
    );

    expect(first).toBe('direct');
    expect(second).toBe('group');
    expect(fetchRoomType).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure, so a transient read is retried', async () => {
    fetchRoomType.mockResolvedValueOnce(null).mockResolvedValueOnce('d');

    expect(await resolveRoomShape(AUTH, 'room-1')).toBeNull();
    expect(await resolveRoomShape(AUTH, 'room-1')).toBe('direct');
  });
});
