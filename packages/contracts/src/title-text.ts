// A record's title as a write takes it: trimmed, not blank, and bounded, each refusal in plain words
// naming the bound, never zod's own text ("Too big: expected string to have <=500 characters").
import { z } from "zod";

/** The longest title a requirement takes; the title input holds a person to it before a save. */
export const REQUIREMENT_TITLE_MAX = 500;

/** A title field of at most `max` characters, refused in words a person reads. */
export const titleText = (max: number) =>
	z
		.string()
		.trim()
		.min(1, "The title is blank: say in a few words what this is.")
		.max(max, `The title is longer than ${max} characters: shorten it to ${max} or fewer.`);
