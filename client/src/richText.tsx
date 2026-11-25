import katex from 'katex';
import type { ReactNode } from 'react';
import type { RegisteredMember } from './api';
import { navigate } from './route';

export type TokenFilter = { kind: 'member' | 'tag'; value: string };

// ---------- editor blocks -> markdown text (what a comment stores) ----------

type Inline = { type?: string; text?: string; href?: string; content?: Inline[]; styles?: Record<string, unknown>; props?: { source?: string } };
type Block = { type: string; props?: Record<string, unknown>; content?: unknown; children?: Block[] };

const cellText = (cell: unknown): string => {
  const content = Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content;
  return inlineMarkdown(content).replace(/\|/g, '\\|').replace(/\n/g, ' ');
};

/** A table block as a markdown table (the first row is the header). */
function tableMarkdown(content: unknown): string[] {
  let rows = ((content as { rows?: { cells?: unknown[] }[] } | null)?.rows ?? []).map((row) => (row.cells ?? []).map(cellText));
  // A new table starts 3 columns wide: leave out empty columns and rows at the end.
  while (rows.length > 1 && rows[rows.length - 1]!.every((c) => !c.trim())) rows = rows.slice(0, -1);
  let width = Math.max(0, ...rows.map((r) => r.length));
  while (width > 1 && rows.every((r) => !(r[width - 1] ?? '').trim())) width--;
  if (!rows.length || !rows.some((r) => r.some((c) => c.trim()))) return [];
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)];
}

function inlineMarkdown(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as Inline[]).map((item) => {
    if (item.type === 'link') {
      // An automatic link swallows the punctuation that follows the address: keep it outside.
      const label = inlineMarkdown(item.content);
      const tail = /[.,;:!?]+$/.exec(label)?.[0] ?? '';
      const href = (item.href ?? '').replace(/[.,;:!?]+$/, tail && (item.href ?? '').endsWith(tail) ? '' : '$&');
      return `[${tail ? label.slice(0, -tail.length) : label}](${href})${tail}`;
    }
    if (item.type === 'latex-inline') return item.props?.source ? `$${item.props.source}$` : '';
    let text = item.text ?? '';
    if (!text.trim()) return text;
    const lead = /^\s*/.exec(text)![0];
    const trail = /\s*$/.exec(text)![0];
    let core = text.trim();
    const s = item.styles ?? {};
    if (s.code) core = `\`${core}\``;
    if (s.bold) core = `**${core}**`;
    if (s.italic) core = `*${core}*`;
    if (s.strike) core = `~~${core}~~`;
    return lead + core + trail;
  }).join('');
}

/** The comment editor's content as markdown, keeping bold, links, lists, code and LaTeX. */
export function blocksToMarkdown(blocks: Block[]): string {
  const lines: string[] = [];
  let number = 0;
  const walk = (list: Block[], depth: number) => {
    for (const block of list) {
      const pad = '  '.repeat(depth);
      const text = inlineMarkdown(block.content);
      number = block.type === 'numberedListItem' ? number + 1 : 0;
      if (block.type === 'heading') lines.push(`${'#'.repeat(Math.min(3, Number(block.props?.level ?? 1)))} ${text}`);
      else if (block.type === 'bulletListItem' || block.type === 'toggleListItem') lines.push(`${pad}- ${text}`);
      else if (block.type === 'numberedListItem') lines.push(`${pad}${number}. ${text}`);
      else if (block.type === 'checkListItem') lines.push(`${pad}- [${block.props?.checked ? 'x' : ' '}] ${text}`);
      else if (block.type === 'quote') lines.push(`> ${text}`);
      else if (block.type === 'codeBlock') lines.push(`\`\`\`${String(block.props?.language ?? '').replace(/[^\w+#-]/g, '')}`, text, '```');
      else if (block.type === 'table') lines.push(...tableMarkdown(block.content));
      else if (block.type === 'image') {
        const url = String(block.props?.url ?? '');
        if (url) lines.push(`![${String(block.props?.caption || block.props?.name || '').replace(/[\]\n]/g, ' ')}](${url})`);
      } else if (['video', 'audio', 'file', 'pdf'].includes(block.type)) {
        const url = String(block.props?.url ?? '');
        if (url) lines.push(`[${String(block.props?.name || block.props?.caption || url).replace(/[\]\n]/g, ' ')}](${url})`);
      }
      else if (block.type === 'latex') {
        if (block.props?.source) lines.push('$$', String(block.props.source), '$$');
      } else lines.push(text);
      if (block.children?.length) walk(block.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- markdown text -> React ----------

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the comment mention this member or use this #tag? */
export function matchesToken(comment: { body: string; author_name: string }, token: TokenFilter): boolean {
  const body = comment.body.toLocaleLowerCase();
  if (token.kind === 'member') return body.includes(`@${token.value.toLocaleLowerCase()}`) || comment.author_name.toLocaleLowerCase() === token.value.toLocaleLowerCase();
  return new RegExp(`#${escapeRe(token.value.toLocaleLowerCase())}(?![\\p{L}\\p{N}_-])`, 'u').test(body);
}

interface Ctx {
  /** Inside a link's text: no further links. */
  noLinks?: boolean;
  members: RegisteredMember[];
  onToken: (token: TokenFilter) => void;
  active: TokenFilter | null;
}

function math(source: string, display: boolean, key: number) {
  let html = '';
  try {
    html = katex.renderToString(source, { displayMode: display, throwOnError: false });
  } catch {
    return <code key={key}>{source}</code>;
  }
  return display
    ? <div key={key} className="comment-math" dangerouslySetInnerHTML={{ __html: html }} />
    : <span key={key} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Img({ alt, src }: { alt: string; src: string }) {
  let url: URL | null = null;
  try {
    url = new URL(src, window.location.origin);
  } catch {
    /* not a URL */
  }
  // https pictures or this site's own files only (no plain http, which browsers block on https pages).
  if (!url || !(url.protocol === 'https:' || url.origin === window.location.origin)) return <>{alt}</>;
  return <a href={url.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><img className="comment-img" src={url.href} alt={alt} loading="lazy" /></a>;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  let url: URL | null = null;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    /* not a URL */
  }
  if (!url || !/^(https?:|mailto:)$/.test(url.protocol)) return <>{children}</>;
  const internal = url.origin === window.location.origin;
  return (
    <a
      className="comment-link"
      href={url.href}
      {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer nofollow' })}
      onClick={(e) => {
        e.stopPropagation();
        // A link to a page or comment of this app opens in place.
        if (internal && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
          e.preventDefault();
          const comment = url!.searchParams.get('comment');
          // A link to a comment on this very page: open it in place (navigating to the same address does nothing).
          if (comment && url!.pathname === window.location.pathname) window.dispatchEvent(new CustomEvent('cloud-doc-goto-comment', { detail: comment }));
          else navigate(url!.pathname + url!.search);
        }
      }}
    >{children}</a>
  );
}

function inline(text: string, ctx: Ctx, base = 0): ReactNode[] {
  const names = ctx.members.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRe);
  const parts = [
    '`([^`\\n]+)`',                                   // 1 code
    '\\$(?!\\s)([^$\\n]*?[^\\s$])\\$(?!\\d)',          // 2 inline math
    // No lookbehind anywhere in this file: Safari only has it from iOS 16.4, and a regex it can't read stops the whole
    // page's code from loading. "Doesn't end in a space" is written into the pattern instead (`.*?\\S`), and the
    // "not right after a word character" check for italics is done in the loop below.
    '\\*\\*(?!\\s)(.*?\\S)\\*\\*',                    // 3 bold
    '~~(?!\\s)(.*?\\S)~~',                           // 4 strike
    '\\*(?![\\s*])(.*?[^\\s*])\\*(?![\\w*])',        // 5 italic
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)',              // 6 text, 7 url
    '(https?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?)\\]\'"])',   // 8 bare url
    names.length ? `(@(?:${names.join('|')})(?![\\p{L}\\p{N}_]))` : '()', // 9 member
    '(#[\\p{L}\\p{N}_-]+)',                           // 10 tag
    '!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)',               // 11 alt, 12 url
  ];
  const re = new RegExp(parts.join('|'), 'giu');
  const out: ReactNode[] = [];
  let last = 0;
  let k = base;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    // an empty match (the member pattern when nobody can be mentioned) says nothing: move on
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    // an italic star right after a word character or another star is just text: look again from the next character
    if (m[5] !== undefined && m.index > 0 && /[\w*]/.test(text[m.index - 1]!)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    if (m.index! > last) out.push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const key = k++;
    if (m[1] !== undefined) out.push(<code key={key} className="comment-code">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(math(m[2], false, key));
    else if (m[11] !== undefined) out.push(<Img key={key} alt={m[11]} src={m[12]!} />);
    else if (m[3] !== undefined) out.push(<strong key={key}>{inline(m[3], ctx, key * 100)}</strong>);
    else if (m[4] !== undefined) out.push(<s key={key}>{inline(m[4], ctx, key * 100)}</s>);
    else if (m[5] !== undefined) out.push(<em key={key}>{inline(m[5], ctx, key * 100)}</em>);
    else if (m[6] !== undefined) out.push(<Link key={key} href={m[7]!}>{inline(m[6], { ...ctx, noLinks: true }, key * 100)}</Link>);
    else if (m[8] !== undefined) out.push(ctx.noLinks ? m[8] : <Link key={key} href={m[8]}>{m[8]}</Link>);
    else if (m[9]) {
      const value = m[9].slice(1);
      const token: TokenFilter = { kind: 'member', value: ctx.members.find((x) => x.name.toLocaleLowerCase() === value.toLocaleLowerCase())?.name ?? value };
      out.push(tokenButton(key, m[9], token, ctx));
    } else if (m[10]) out.push(tokenButton(key, m[10], { kind: 'tag', value: m[10].slice(1) }, ctx));
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function tokenButton(key: number, label: string, token: TokenFilter, ctx: Ctx) {
  const on = ctx.active?.kind === token.kind && ctx.active.value.toLocaleLowerCase() === token.value.toLocaleLowerCase();
  return (
    <span
      key={key}
      role="button"
      tabIndex={0}
      className={`comment-token comment-token-${token.kind}${on ? ' is-on' : ''}`}
      title={token.kind === 'member' ? `Show comments with ${label}` : `Show comments tagged ${label}`}
      onClick={(e) => { e.stopPropagation(); ctx.onToken(token); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onToken(token); } }}
    >{label}</span>
  );
}

/** A comment's text as formatted content: markdown, links (also bare URLs), LaTeX, @members and #keywords. */
export function RichText({ text, members, onToken, active }: { text: string } & Ctx) {
  const ctx: Ctx = { members, onToken, active };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      i++;
      out.push(<pre key={key++} className="comment-pre"><code>{code.join('\n')}</code></pre>);
    } else if (/^\$\$\s*$/.test(line)) {
      const src: string[] = [];
      for (i++; i < lines.length && !/^\$\$\s*$/.test(lines[i]!); i++) src.push(lines[i]!);
      i++;
      out.push(math(src.join('\n'), true, key++));
    } else if (/^\s*\|.*\|?\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      // cells are split at every | that has no backslash in front of it
      const split = (row: string) => {
        const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
        const cells: string[] = [];
        let from = 0;
        for (let at = 0; at < body.length; at++) {
          if (body[at] === '|' && body[at - 1] !== '\\') {
            cells.push(body.slice(from, at));
            from = at + 1;
          }
        }
        cells.push(body.slice(from));
        return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
      };
      const head = split(line);
      const align = split(lines[i + 1]!).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left') as 'left' | 'center' | 'right');
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]!); i++) rows.push(split(lines[i]!));
      out.push(
        <div key={key++} className="comment-table-wrap">
          <table className="comment-table">
            <thead><tr>{head.map((c, n) => <th key={n} style={{ textAlign: align[n] }}>{inline(c, ctx, n * 1000)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, n) => <td key={n} style={{ textAlign: align[n] }}>{inline(r[n] ?? '', ctx, (ri * 50 + n) * 1000)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className="comment-hr" />);
      i++;
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!); i++) {
        const raw = lines[i]!;
        const depth = Math.floor(/^\s*/.exec(raw)![0].length / 2);
        const body = raw.replace(/^\s*([-*+]|\d+\.)\s+/, '');
        const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
        items.push(
          <li key={items.length} style={depth ? { marginLeft: depth * 16 } : undefined} className={task ? 'comment-task' : undefined}>
            {task && <input type="checkbox" checked={task[1] !== ' '} readOnly tabIndex={-1} aria-label="task" />}
            {inline(task ? task[2]! : body, ctx, items.length * 1000)}
          </li>,
        );
      }
      out.push(ordered ? <ol key={key++} className="comment-list">{items}</ol> : <ul key={key++} className="comment-list">{items}</ul>);
    } else if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^>\s?/, ''));
      out.push(<blockquote key={key++} className="comment-quote">{inline(quote.join('\n'), ctx)}</blockquote>);
    } else if (/^#{1,3}\s+\S/.test(line)) {
      out.push(<div key={key++} className="comment-heading">{inline(line.replace(/^#{1,3}\s+/, ''), ctx)}</div>);
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      out.push(<p key={key++} className="comment-p">{inline(line, ctx)}</p>);
      i++;
    }
  }
  return <div className="comment-rich">{out}</div>;
}
