/**
 * Antigravity Response Parser
 *
 * Parse and clean Antigravity response text for readable output.
 *
 * Antigravity flattens Claude's structured output into plain text:
 * - Code fences (```) are stripped or escaped as \`\`\`
 * - Inline code references get extracted onto their own lines
 * - "Copy" button labels appear as standalone lines
 * - Code blocks lose structure and get mixed with prose
 *
 * This parser:
 * 1. Restores escaped code fences
 * 2. Reconstructs code blocks from fenceless code runs
 * 3. Strips "Copy" artifacts
 * 4. Re-joins broken prose lines
 */

export function parseAntigravityResponse(text: string): string {
    // Step 1: Restore escaped code fences
    // Antigravity escapes ``` as \`\`\` or `\`\`\`` or similar patterns
    let cleaned = text
        .replace(/`\\`\\`\\``/g, '```')       // `\`\`\`` → ```
        .replace(/\\`\\`\\`/g, '```')          // \`\`\` → ```
        .replace(/`{3,}/g, '```');             // ```` or more → ```

    // Step 2: Strip "Copy" artifacts (button labels from Antigravity UI)
    cleaned = cleaned.replace(/^Copy\n/g, '').replace(/\nCopy$/g, '');
    const lines = cleaned.split('\n');
    const filtered = lines.filter((line, i) => {
        if (line.trim() !== 'Copy') return true;
        // Keep "Copy" if it's inside a code block context
        const nextLine = lines[i + 1]?.trim() || '';
        const prevLine = lines[i - 1]?.trim() || '';
        if (prevLine.startsWith('```') || nextLine.startsWith('```')) return false;
        return false; // Strip all standalone "Copy" lines
    });

    // Step 3: Reconstruct code blocks from fenceless code runs
    // Walk lines, detect runs of 2+ consecutive code-like lines, wrap in fences
    const withFences = reconstructCodeBlocks(filtered);

    // Step 4: Re-join broken prose lines (skip lines inside code fences)
    const result: string[] = [];
    let inCodeFence = false;
    for (const line of withFences) {
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            inCodeFence = !inCodeFence;
            result.push(line);
            continue;
        }
        if (inCodeFence) {
            result.push(line);
            continue;
        }

        if (result.length === 0 || trimmed === '') {
            result.push(line);
            continue;
        }

        const prev = result[result.length - 1].trimEnd();

        if (isBlockElement(trimmed) || prev === '') {
            result.push(line);
            continue;
        }

        // Join continuations: lowercase start, punctuation, or short code-like fragments
        const isContinuationStart = /^[a-z,.:;!?)\]}]/.test(trimmed);
        const prevEndsMidSentence = !/[.!?:]\s*$/.test(prev);
        const isShortFragment = trimmed.length <= 40 && !/\s/.test(trimmed);

        if (isContinuationStart || (prevEndsMidSentence && isShortFragment)) {
            const needsSpace = !prev.endsWith(' ') && !/^[,.:;!?)\]}]/.test(trimmed);
            const sep = needsSpace ? ' ' : '';
            if (isShortFragment && prevEndsMidSentence && isCodeLike(trimmed)) {
                result[result.length - 1] = `${prev}${sep}\`${trimmed}\``;
            } else {
                result[result.length - 1] = `${prev}${sep}${trimmed}`;
            }
        } else {
            result.push(line);
        }
    }

    return result.join('\n').trim();
}

/**
 * Detect runs of fenceless code lines and wrap them in ``` fences.
 * A code run = 2+ consecutive lines matching isCodeLine().
 * Single code-like lines stay inline (handled by the join logic).
 */
function reconstructCodeBlocks(lines: string[]): string[] {
    const output: string[] = [];
    let i = 0;
    let inExistingFence = false;

    while (i < lines.length) {
        const trimmed = lines[i].trim();

        // Track existing fences — don't double-wrap
        if (trimmed.startsWith('```')) {
            inExistingFence = !inExistingFence;
            output.push(lines[i]);
            i++;
            continue;
        }
        if (inExistingFence) {
            output.push(lines[i]);
            i++;
            continue;
        }

        // Check for start of a code run
        if (isCodeLine(trimmed)) {
            // Look ahead to count consecutive code lines
            let runEnd = i + 1;
            while (runEnd < lines.length) {
                const nextTrimmed = lines[runEnd].trim();
                if (nextTrimmed.startsWith('```')) break; // hit existing fence
                if (nextTrimmed === '') { // blank line — peek past it
                    const afterBlank = lines[runEnd + 1]?.trim() || '';
                    if (isCodeLine(afterBlank)) { runEnd++; continue; }
                    break;
                }
                if (!isCodeLine(nextTrimmed)) break;
                runEnd++;
            }

            const runLength = runEnd - i;
            if (runLength >= 2) {
                // Insert opening fence with inferred language
                const lang = inferLanguage(lines[i].trim());
                output.push(`\`\`\`${lang}`);
                for (let j = i; j < runEnd; j++) {
                    output.push(lines[j]);
                }
                output.push('```');
                i = runEnd;
                continue;
            }
        }

        output.push(lines[i]);
        i++;
    }

    return output;
}

/** Detect if a line looks like code (not prose). */
function isCodeLine(line: string): boolean {
    if (!line || line.trim() === '') return false;
    const t = line.trim();
    // Markdown prose indicators — NOT code
    if (/^(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|---|\|)/.test(t)) return false;
    // Sentences (starts uppercase, contains spaces, ends with period) — prose
    if (/^[A-Z][a-z].*\s.*[.!?]$/.test(t)) return false;
    // Code indicators
    if (/^\s{2,}/.test(line)) return true;  // indented 2+ spaces
    if (/^\t/.test(line)) return true;       // tab-indented
    if (/^(const |let |var |function |import |export |class |interface |type |enum |async |await |return |if |else |for |while |switch |case |try |catch |throw )/.test(t)) return true;
    if (/^(def |from |print|raise |except |elif )/.test(t)) return true; // Python
    if (/^(curl |npm |node |git |echo |mkdir |cd |cp |mv |rm )/.test(t)) return true; // shell
    if (/^[{}()\[\];]$/.test(t)) return true; // lone brackets
    if (/^\/\/|^#!|^#\s/.test(t) && t.length < 80) return true; // comments
    if (/[=>{};]\s*$/.test(t)) return true;  // ends with code punctuation
    if (/^\w+\(.*\)[;,]?\s*$/.test(t)) return true; // function calls
    if (/^\w+\.\w+/.test(t) && !/\s{2,}/.test(t)) return true; // method chains
    return false;
}

/** Infer language from the first line of a code block. */
function inferLanguage(firstLine: string): string {
    if (/^(import |export |const |let |var |interface |type |async )/.test(firstLine)) return 'typescript';
    if (/^(function |class )/.test(firstLine)) return 'typescript';
    if (/^(def |from |import |class |print)/.test(firstLine)) return 'python';
    if (/^(curl |npm |node |git |echo |mkdir |cd |\.\/|#!)/.test(firstLine)) return 'bash';
    if (/^\{|\[/.test(firstLine)) return 'json';
    if (/^<\w/.test(firstLine)) return 'html';
    return '';
}

/** Check if a line is a markdown block element that should stay on its own line. */
function isBlockElement(line: string): boolean {
    const t = line.trim();
    return /^(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|```|---|\|)/.test(t);
}

/** Check if a short standalone token looks like code (filename, path, identifier). */
function isCodeLike(token: string): boolean {
    if (/[._/\\:]/.test(token)) return true;
    if (/^[a-z]+[A-Z]/.test(token)) return true;
    if (/^[A-Z][A-Z_]{2,}$/.test(token)) return true;
    return false;
}
