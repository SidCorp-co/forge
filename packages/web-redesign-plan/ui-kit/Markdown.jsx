/* Forge UI Kit — Markdown.jsx
   Lightweight markdown renderer for issue descriptions, agent plans, and
   comment bodies. Handles headings, bold, inline code, fenced code blocks,
   bullet/numbered lists, task checkboxes, tables, links, and image blocks
   (rendered as attachment placeholders). No external deps. */

function mdInline(text, kp) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/;
  let rest = String(text), n = 0;
  while (rest.length) {
    const m = rest.match(re);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[1] != null) out.push(<strong key={kp + n} style={{ fontWeight: 700, color: 'var(--fg-default)' }}>{m[1]}</strong>);
    else if (m[2] != null) out.push(<code key={kp + n} className="fg-code">{m[2]}</code>);
    else if (m[3] != null) out.push(<span key={kp + n} style={{ color: 'var(--link)', fontWeight: 500 }}>{m[3]}</span>);
    rest = rest.slice(m.index + m[0].length); n++;
  }
  return out;
}

function ImageAttachment({ name, caption, src }) {
  const real = src && !src.startsWith('att://');
  return (
    <figure style={{ margin: 0, border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--bg-surface)' }}>
      {real
        ? <img src={src} alt={caption || name} style={{ display: 'block', width: '100%', height: 156, objectFit: 'cover', objectPosition: 'top', borderBottom: '1px solid var(--border-subtle)', background: 'var(--paper-100)' }} />
        : <div style={{ height: 132, background: 'repeating-linear-gradient(135deg, var(--paper-100) 0 12px, var(--paper-50) 12px 24px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 7, borderBottom: '1px solid var(--border-subtle)' }}>
            <Icon name="monitor" size={26} style={{ color: 'var(--ink-400)' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-subtle)', letterSpacing: '0.04em' }}>SCREENSHOT</span>
          </div>}
      <figcaption style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px' }}>
        <Icon name="link" size={12} style={{ color: 'var(--fg-subtle)' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || caption}</span>
      </figcaption>
    </figure>
  );
}

function Markdown({ text, compact }) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let i = 0, key = 0;
  const gap = compact ? 8 : 12;

  while (i < lines.length) {
    let line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // fenced code
    if (line.trim().startsWith('```')) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(
        <pre key={key++} style={{ margin: 0, padding: '11px 13px', background: 'var(--bg-sunken)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-md)', overflowX: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.55, color: 'var(--ink-700)' }}>{buf.join('\n')}</pre>);
      continue;
    }

    // image block
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (img) {
      const imgs = [];
      while (i < lines.length && lines[i].match(/^!\[([^\]]*)\]\(([^)]+)\)/)) {
        const mm = lines[i].match(/^!\[([^\]]*)\]\(([^)]+)\)/);
        imgs.push({ alt: mm[1], src: mm[2] }); i++;
      }
      blocks.push(
        <div key={key++} style={{ display: 'grid', gridTemplateColumns: imgs.length > 1 ? 'repeat(2, 1fr)' : '1fr', gap: 10 }}>
          {imgs.map((a, j) => <ImageAttachment key={j} caption={a.alt} name={a.alt} src={a.src} />)}
        </div>);
      continue;
    }

    // table
    if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i]); i++; }
      const parse = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const header = parse(rows[0]);
      const body = rows.slice(2); // skip |---| separator
      blocks.push(
        <div key={key++} style={{ overflowX: 'auto', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><tr>{header.map((h, j) => <th key={j} style={{ textAlign: 'left', padding: '8px 11px', background: 'var(--paper-50)', borderBottom: '1px solid var(--border-default)', fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => { const cells = parse(r); return <tr key={ri}>{cells.map((c, ci) => <td key={ci} style={{ padding: '8px 11px', borderBottom: ri < body.length - 1 ? '1px solid var(--border-subtle)' : 'none', color: 'var(--fg-muted)', verticalAlign: 'top' }}>{mdInline(c, `t${ri}${ci}`)}</td>)}</tr>; })}</tbody>
          </table>
        </div>);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const lvl = h[1].length;
      const size = lvl <= 1 ? 19 : lvl === 2 ? 16.5 : lvl === 3 ? 14.5 : 13.5;
      blocks.push(<div key={key++} style={{ fontWeight: 700, fontSize: size, letterSpacing: '-0.01em', color: 'var(--fg-default)', marginTop: blocks.length ? 4 : 0 }}>{mdInline(h[2], 'h' + key)}</div>);
      i++; continue;
    }

    // unordered / task list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*[-*]\s+/, '');
        const task = raw.match(/^\[([ xX])\]\s+(.*)/);
        items.push(task ? { check: task[1].toLowerCase() === 'x', text: task[2] } : { text: raw });
        i++;
      }
      blocks.push(
        <ul key={key++} style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it, j) => (
            <li key={j} style={{ display: 'flex', gap: 9, fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
              {it.check != null
                ? <span style={{ width: 17, height: 17, marginTop: 1, borderRadius: 5, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: it.check ? 'var(--green-500)' : 'var(--bg-surface)', border: `1.5px solid ${it.check ? 'var(--green-500)' : 'var(--border-strong)'}` }}>{it.check && <Icon name="check" size={11} strokeWidth={3} style={{ color: '#fff' }} />}</span>
                : <span style={{ color: 'var(--fg-subtle)', marginTop: 1, flex: 'none' }}>•</span>}
              <span>{mdInline(it.text, 'li' + j)}</span>
            </li>
          ))}
        </ul>);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push(
        <ol key={key++} style={{ margin: 0, paddingLeft: 4, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6, counterReset: 'md' }}>
          {items.map((it, j) => (
            <li key={j} style={{ display: 'flex', gap: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-text)', fontWeight: 600, flex: 'none', marginTop: 1 }}>{j + 1}.</span>
              <span>{mdInline(it, 'ol' + j)}</span>
            </li>
          ))}
        </ol>);
      continue;
    }

    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\||```|!\[)/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(<p key={key++} style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--fg-muted)' }}>{mdInline(para.join(' '), 'p' + key)}</p>);
  }

  return <div style={{ display: 'flex', flexDirection: 'column', gap }}>{blocks}</div>;
}

Object.assign(window, { Markdown, ImageAttachment, mdInline });
