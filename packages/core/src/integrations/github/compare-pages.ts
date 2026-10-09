// The files of one compare, taken a page at a time. GitHub names a compare's files 100 to a page
// and at most 3000 in all; the first page alone stops at the first hundred, so a release range of
// a few hundred files read from page one was refused as "too many" when it was only more than a page.

/** One file entry of a compare answer. */
export interface CompareFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
}

const PAGE_SIZE = 100;
/** GitHub names no more than this many files of one compare, over any number of pages. */
export const COMPARE_FILE_CEILING = 3000;
const MAX_PAGES = COMPARE_FILE_CEILING / PAGE_SIZE;

interface ComparePage {
  status?: string;
  files?: CompareFile[];
}

/**
 * Every file of `path` (a compare URL without its query), or the reason the list cannot be taken
 * whole: a page that names no list, or a compare that fills every page it is allowed.
 */
export async function readCompareFiles(
  get: <T>(path: string) => Promise<T>,
  path: string,
): Promise<{ status: string | undefined; files: CompareFile[] } | { why: string }> {
  const files: CompareFile[] = [];
  let status: string | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const read = await get<ComparePage>(`${path}?per_page=${PAGE_SIZE}&page=${page}`);
    status ??= read.status;
    if (!Array.isArray(read.files)) return { why: 'the compare answered no file list' };
    files.push(...read.files);
    if (read.files.length < PAGE_SIZE) return { status, files };
  }
  return {
    why: `${COMPARE_FILE_CEILING} or more files differ, and the repository names no more than that in one compare`,
  };
}
