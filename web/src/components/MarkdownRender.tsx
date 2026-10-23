import { memo, type ReactNode, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n';
import { clipSegments } from '../lib/fences';
import { CODE_CLIP, CodeBlock, ShowAll } from './CodeBlock';
import css from './Markdown.module.css';

/** The only links that become links; any other scheme (javascript:, data:, file:) is text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

interface MdNode {
  type: string;
  value?: string;
  label?: string;
  identifier?: string;
  children?: MdNode[];
}

const asText = (value: string): MdNode => ({ type: 'text', value });

/**
 * GFM footnotes shown as written ("[^1]", "[^1]: …") rather than as a footnote section: that
 * section links by in-page anchors, which would change this app's URL (it routes by the hash),
 * repeats ids across messages, and labels itself in English. Iterative, so deeply nested text
 * cannot overflow the stack here.
 */
function footnotesAsText() {
  return (tree: MdNode) => {
    const stack: MdNode[] = [tree];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (!node.children) continue;
      node.children = node.children.flatMap((child): MdNode[] => {
        const label = `[^${child.label ?? child.identifier ?? ''}]`;
        if (child.type === 'footnoteReference') return [asText(label)];
        if (child.type !== 'footnoteDefinition') return [child];
        const [first, ...rest] = child.children ?? [];
        const lead = asText(`${label}: `);
        return first?.type === 'paragraph'
          ? [{ ...first, children: [lead, ...(first.children ?? [])] }, ...rest]
          : [{ type: 'paragraph', children: [lead] }, ...(first ? [first] : []), ...rest];
      });
      stack.push(...node.children);
    }
  };
}

// Raw HTML needs no step of its own: without rehype-raw, react-markdown shows it as text.
const PLUGINS = [remarkGfm, footnotesAsText];

/**
 * A reply's headings sit inside a panel whose cells are h4: its h1 becomes an h5 and the rest
 * h6, each still sized by its own level.
 */
const heading =
  (level: number) =>
  ({ children }: { children?: ReactNode }) => {
    const Tag = level === 1 ? 'h5' : 'h6';
    return <Tag className={css[`h${level}`]}>{children}</Tag>;
  };

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

const hastText = (n: HastNode | undefined): string =>
  n === undefined
    ? ''
    : n.type === 'text'
      ? (n.value ?? '')
      : (n.children ?? []).map(hastText).join('');

/** The language a fenced block names ("language-ts" → "ts"). */
function langOf(code: HastNode | undefined): string | null {
  const classes = code?.properties?.className;
  const lang = Array.isArray(classes)
    ? classes.find((c): c is string => typeof c === 'string' && c.startsWith('language-'))
    : undefined;
  return lang ? lang.slice('language-'.length) : null;
}

export interface MarkdownProps {
  text: string;
  /** Names the "show all" dialog and code blocks. */
  label: string;
}

/**
 * Markdown, as model replies are written: GitHub's flavour (tables, task lists, strikethrough).
 * Never renders raw HTML, links only http(s) and mailto (in a new tab), and never loads an
 * image: glassbox makes no requests of its own, so an image is its alt text and URL. Code blocks
 * are glassbox's code blocks; unindented ones are cut out of the text first, so each shows and
 * copies whole (those inside list items stay in their list). Only the first `clip` characters of
 * prose are parsed; "show all" opens the whole text as source.
 */
export const MarkdownRender = memo(function MarkdownRender({
  text,
  label,
  clip,
}: MarkdownProps & { clip: number }) {
  const { t } = useI18n();
  // Unindented fences are cut out first: each block shows whole, outside the prose budget.
  const { parts, cut } = useMemo(
    () =>
      clipSegments(text, { prose: clip, code: 4 * CODE_CLIP, codeClip: CODE_CLIP, maxIndent: 0 }),
    [text, clip],
  );
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) =>
        href && SAFE_LINK.test(href.trim()) ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <span className={css.unlinked}>{children}</span>
        ),
      img: ({ src, alt }) => (
        <span className={css.image}>
          {t('markdown.image', { alt: alt ?? '' })}
          {typeof src === 'string' && src ? ` ${src}` : ''}
        </span>
      ),
      pre: ({ node }) => {
        const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === 'code');
        return (
          <CodeBlock text={hastText(code).replace(/\n$/, '')} lang={langOf(code)} label={label} />
        );
      },
      // Fenced code is handled by `pre`; what reaches here is inline code.
      code: ({ children }) => <code className={css.inline}>{children}</code>,
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
      table: ({ children }) => (
        <div className={css.tableWrap} data-scroll-region>
          <table>{children}</table>
        </div>
      ),
    }),
    [t, label],
  );
  // The parse is the expensive part: redone only when the text or the renderers change.
  const rendered = useMemo(
    () =>
      parts.map((p, i) =>
        p.kind === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable text
          <CodeBlock key={i} text={p.text} lang={p.lang} label={label} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable text
          <ReactMarkdown key={i} remarkPlugins={PLUGINS} components={components}>
            {p.text}
          </ReactMarkdown>
        ),
      ),
    [parts, components, label],
  );
  return (
    <div className={css.markdown}>
      {rendered}
      {cut && <ShowAll label={label} text={text} />}
    </div>
  );
});
