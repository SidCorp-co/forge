// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// Per-file analysis: comments -> annotations + grammar diagnostics (codemap/1 §7 grammar tier).
//
// `proseKeys` is the file's answer to "what prose text do I contain" — the set the baseline is built
// from, and the set `cm verify` and `cm sweep --prune-baseline` diff against to decide a frozen comment
// is GONE. Sited prose belongs in it. Leaving it out looked like a saving (freezing a key that decides
// nothing today) and cost the baseline its only guarantee: annotating one block reported its untouched
// neighbours as cleaned debt, prune then dropped their keys as stale, and deleting the annotation turned
// legacy prose nobody had edited into a permanent CM001 with no way back but a full re-freeze. Siting is
// applied where the verdict is (`sited` below), which is what keeps that block reported regardless.

import { profileFor, isGenerated } from './languages.mjs';
import { scanComments, nextCodeLine } from './scan.mjs';
import { parseAnnotation, canonical, hasTodo, diag, PROSE_CODES, baselineKey } from './parse.mjs';
import { enforcementFor } from './registry.mjs';

// cm:why a docblock carrying structured tags is machine-consumed, not narration, so it is exempt
const STRUCTURED_DOC = /@(param|returns?|type|template|satisfies|throws|var|property|method|mixin|deprecated|example|see|link|inheritDoc)\b/;

// cm:why CM011 measures a header's LENGTH, not one comment's text, so it can never be owned by a site
const SITEABLE = new Set(['CM001', 'CM010']);

export function analyzeFile({ relPath, src, reg, frozen }) {
  const prof = profileFor(relPath);
  if (!prof) return { skipped: 'no-profile', annotations: [], diags: [], proseKeys: [] };
  if (isGenerated(src)) return { skipped: 'generated', annotations: [], diags: [], proseKeys: [] };

  const { grammar, docPolicy } = enforcementFor(reg, prof);
  const lines = src.split('\n');
  const { comments, codeLines } = scanComments(src, prof);

  const annotations = [];
  const raw = [];
  const ignores = new Map();
  const annLines = new Map();
  const annAt = new Map();

  const header = moduleHeader(lines, comments, codeLines, prof);
  const headerMax = reg.enforce?.headerMaxLines ?? 20;
  // cm:guard CM011 is prose-family (PROSE_CODES), so `grammar: false` must silence it too — a repo
  // adopting the graph without the comment discipline was still getting header-length errors
  if (grammar && header && !header.glued && header.count > headerMax) {
    raw.push({ ...diag('CM011', relPath, header.start, `${header.count} lines (max ${headerMax})`), text: `header:${header.count}` });
  }
  const inHeader = (c) => !!header && !header.glued && c.line >= header.start && c.endLine <= header.end;
  const nearHeader = (line) => !!header && !!header.glued && line >= header.start && line <= header.end;

  for (const c of comments) {
    if (c.kind !== 'line') {
      let misplaced = false;
      for (const l of c.lines) {
        if (/^cm:/.test(l.text)) {
          raw.push(diag('CM003', relPath, l.line, l.text.slice(0, 60)));
          misplaced = true;
        }
      }
      // cm:why CM003 is the actionable diagnostic, so a misplaced block is not also billed as prose
      const hoverDoc = c.kind === 'doc' && prof.docBlocksAllowed;
      if (!misplaced && grammar && docPolicy === 'banned' && c.text && !inHeader(c) && !hoverDoc &&
          !STRUCTURED_DOC.test(c.text) && !prof.exempt.some((re) => re.test(c.text))) {
        raw.push({ ...diag('CM001', relPath, c.line, trunc(c.text)), text: c.text });
      }
      continue;
    }

    const text = c.text;
    if (!text) continue;

    if (/^cm:/.test(text)) {
      const parsed = parseAnnotation(text, relPath, c.line);
      if (!parsed) continue;
      if (parsed.ignore) {
        const set = ignores.get(c.line) ?? new Set();
        set.add(parsed.ignore.code);
        ignores.set(c.line, set);
        continue;
      }
      // cm:guard register the LINE before the parse verdict — §4 makes the comment below a cm: line its
      //   continuation parsed or not, and a malformed one that forfeits its wrap bills it as prose (ISS-6)
      annLines.set(c.line, c.leader);
      // cm:why col + leader ride along so `cm fmt` can rewrite a resolvable ../ target positionally, the
      //   same way CM009 is rewritten — the diagnostic is the only place that knows where the target sits
      if (parsed.diags) {
        for (const d of parsed.diags) raw.push(d.relative ? { ...d, col: c.col, leader: c.leader } : d);
        continue;
      }
      const ann = { ...parsed.ann, indent: c.indent ?? '', leader: c.leader, col: c.col };
      annotations.push(ann);
      annAt.set(c.line, ann);
      const want = canonical(ann);
      // cm:why col + leader travel with the diagnostic so the rewrite is positional, not a re-match
      if (text !== want) {
        raw.push({ ...diag('CM009', relPath, c.line, text), canonical: want, col: c.col, leader: c.leader });
      }
      continue;
    }

    if (prof.exempt.some((re) => re.test(text))) continue;

    if (grammar && hasTodo(text)) {
      raw.push({ ...diag('CM010', relPath, c.line, trunc(text)), text });
      continue;
    }

    // cm:why an annotation may wrap onto exactly ONE following line — enough for a sentence that does not
    // fit, while a third line is prose again, so this cannot become a licence to dump a paragraph (§4)
    // cm:guard the wrap goes in `wrap`, never joined into `text` — canonical() reads `text` and cm fmt
    //   writes it back at the annotation's own column, so joining duplicates the wrap onto line one (ISS-3)
    if (c.firstOnLine !== false && annLines.get(c.line - 1) === c.leader) {
      // cm:guard a line already FROZEN was prose when the baseline was taken, so it cannot be a wrap the
      //   annotation's author wrote — adopting one fused a stranger's sentence into an injected guard (ISS-22)
      if (!frozen?.has(baselineKey(text))) {
        const prev = annAt.get(c.line - 1);
        if (prev) prev.wrap = text;
        continue;
      }
    }

    if (!grammar || inHeader(c)) continue;

    if (docPolicy === 'banned') {
      raw.push({ ...diag('CM001', relPath, c.line, trunc(text)), text });
    } else if (docPolicy === 'required-on-exported') {
      // cm:why godoc/revive require a comment above every exported declaration, so only that position is exempt
      const exempt = c.firstOnLine && documentsExported(lines, codeLines, c.line, prof);
      if (!exempt) raw.push({ ...diag('CM001', relPath, c.line, trunc(text)), text });
    }
  }

  const diags = raw.filter((d) => {
    const above = ignores.get(d.line - 1);
    const same = ignores.get(d.line);
    return !(above?.has(d.code) || same?.has(d.code));
  });

  // cm:why a whole orientation run reported line-by-line with "delete it" reads as a verdict on the prose
  // when the file is one blank line away from a legal header — say which, and the author can choose
  for (const d of diags) {
    if (d.code === 'CM001' && nearHeader(d.line)) {
      d.fix = `this run is at the top of the file — a blank line between it and the first statement makes it a module header (§4.1, max ${headerMax} lines). Otherwise: ${d.fix}`;
    }
  }

  const blocks = siteProse(comments, annotations, diags);

  const proseKeys = [...new Set(diags.filter((d) => PROSE_CODES.has(d.code))
    .map((d) => baselineKey(d.text ?? d.message)))];
  // cm:why a reflow moves no words but changes every line key, which unfroze whole comments and had sweep
  //   advise pruning them — a BLOCK key survives rewrapping, and the line keys beside it stay granular (ISS-21)
  const blockKeys = [];
  for (const b of blocks) {
    const mine = diags.filter((d) => PROSE_CODES.has(d.code) && d.line >= b.start && d.line <= b.end);
    if (!mine.length) continue;
    const key = `b:${baselineKey(b.text)}`;
    for (const d of mine) d.blockKey = key;
    blockKeys.push(key);
  }

  return {
    annotations,
    diags,
    // cm:why an ignore is a property of the SITE, not of one tier — the fix line for CM102 and CM301 both
    //   offer it, and they are raised from the graph long after this function's own filter has run
    ignores,
    // cm:guard every prose violation belongs here, sited ones included — see the header for what breaks
    proseKeys,
    // cm:guard frozen but never COUNTED — a block key is one comment's reflow-invariant shadow, not a
    //   comment, so counting it would inflate the debt line the case study quotes as ground truth
    blockKeys,
    // cm:guard the "is that frozen comment GONE" test reads THIS, never proseKeys — words that moved into a
    //   cm: tag are still in the file, so a relabel cannot report the debt as paid (ISS-25)
    presentKeys: [...new Set([
      ...proseKeys, ...blockKeys,
      ...annotations.flatMap((a) => [a.text, a.wrap].filter(Boolean).map((t) => baselineKey(t))),
    ])],
    skipped: null,
  };
}

// cm:why the baseline spares legacy prose everywhere except a block its author has just annotated: that
// is the one place the tool can tell "you worked here and left the noise" from "this predates you" (§8)
function siteProse(comments, annotations, diags) {
  const annLines = new Set(annotations.map((a) => a.line));
  const blocks = [];

  const standalone = comments.filter((c) => c.firstOnLine !== false).sort((a, b) => a.line - b.line);
  for (let i = 0; i < standalone.length;) {
    let end = standalone[i].endLine;
    const start = standalone[i].line;
    let j = i + 1;
    while (j < standalone.length && standalone[j].line <= end + 1) {
      end = Math.max(end, standalone[j].endLine);
      j++;
    }
    if (annLines.size && [...annLines].some((l) => l >= start && l <= end)) {
      for (const d of diags) {
        if (SITEABLE.has(d.code) && d.line >= start && d.line <= end) d.sited = true;
      }
    }
    // cm:why the block is the unit a human actually deletes, and the one a reflow preserves — CASE-STUDY's
    //   Method folds contiguous standalone lines by hand for the same reason (ISS-21)
    blocks.push({
      start,
      end,
      text: standalone.slice(i, j).map((c) => c.text).filter(Boolean).join(' '),
    });
    i = j;
  }
  return blocks;
}

// cm:why the trailing blank line is what separates a header from narration glued to the first statement (§4.1)
// cm:guard `glued` is a REPORTED near-miss, never an exemption — widening the header to cover it would
//   license narration above the first statement, which is §4.1's whole subject
function moduleHeader(lines, comments, codeLines, prof) {
  let start = 1;
  if (lines[0]?.startsWith('#!')) start = 2;
  let prologueEnd = 0;
  for (;;) {
    while (start <= lines.length && lines[start - 1].trim() === '') start++;
    if (!prof?.prologue?.test(lines[start - 1] ?? '')) break;
    prologueEnd = start;
    start++;
  }

  const first = comments.find((c) => c.line === start);
  if (!first) return null;

  let end = first.endLine;
  for (;;) {
    const next = comments.find((c) => c.line === end + 1);
    if (!next) break;
    end = next.endLine;
  }

  const firstCode = Math.min(...[...codeLines].filter((l) => l > prologueEnd), Infinity);
  if (firstCode <= end) return null;
  if (lines[end] === undefined || lines[end].trim() !== '') return { start, end, glued: true };

  return { start, end, count: end - start + 1 };
}

function documentsExported(lines, codeLines, fromLine, prof) {
  const next = nextCodeLine(lines, codeLines, fromLine + 1);
  if (!next) return false;
  if (prof.exportedDecl?.test(next.text)) return true;
  return prof.exportedMember?.test(next.text) ? inMemberBlock(lines, next.line, prof) : false;
}

/**
 * Is this line a member of an exported struct / interface / const / var block?
 *
 * The nearest line at column ZERO above it is the declaration it belongs to — a bounded backward walk,
 * not a nesting model. `func` there means we are in a body and narration is narration; `}` means we are
 * back at top level, where `exportedDecl` already has the answer.
 */
function inMemberBlock(lines, fromLine, prof) {
  for (let i = fromLine - 1; i >= 1; i--) {
    const raw = lines[i - 1];
    if (raw === undefined || raw.trim() === '' || /^\s/.test(raw)) continue;
    return prof.memberBlock.test(raw);
  }
  return false;
}

function trunc(s) {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
