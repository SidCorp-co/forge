import type { MessageVerdict } from './contract.js';
import { admitted } from './screen.js';

export const screenPasses = async (
  _door: unknown,
  input: { segments: readonly string[] },
): Promise<MessageVerdict> => admitted(input.segments);

/** Stands in for `screenAtDoor`, which is synchronous and takes the segments directly. */
export const screenAtDoorPasses = (_door: unknown, segments: readonly string[]): MessageVerdict =>
  admitted(segments);
