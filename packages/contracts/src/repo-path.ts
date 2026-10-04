// A repository-relative path, as a link's call site, a workflow node and an observation name a file
// inside a checkout. One shape, so every schema that takes one refuses the same paths.

import { z } from "zod";

export const REPO_PATH_MAX = 400;

/** A segment is anything but a separator, a backslash or a control character, and never `.` or `..`: the path names a file inside the checkout, so it neither starts at a root nor climbs out of one. */
export const REPO_PATH =
	/^(?![A-Za-z]:)(?!(?:.*\/)?\.{1,2}(?:\/|$))[^/\\\p{Cc}]+(?:\/[^/\\\p{Cc}]+)*$/u;

export const REPO_PATH_MESSAGE =
	"a repository-relative path: no leading `/` or drive, no `.` or `..` segment, no empty segment, no backslash";

export const repoPath = () =>
	z
		.string()
		.min(1)
		.max(REPO_PATH_MAX)
		.regex(REPO_PATH, { message: REPO_PATH_MESSAGE });
