import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n';
import { clipSegments } from '../lib/fences';
import { CodeBlock, ShowAll } from './CodeBlock';
import css from './Markdown.module.css';

/** The only links that become links; any other scheme (javascript:, data:, file:) is text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** Containers whose children are blocks: raw HTML there becomes a paragraph of its text. */
const FLOW = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/**
 * Raw HTML in the text stays text: a remark step turns HTML nodes into text nodes before
 * anything is rendered. (Without it react-markdown would drop them silently.)
 */
function htmlAsText() {
  const walk = (node: MdNode) => {
    node.children = node.children?.map((child) => {
      if (child.type !== 'html') {
        walk(child);
        return child;
      }
      const text = { type: 'text', value: child.value ?? '' };
      return FLOW.has(node.type) ? { type: 'paragraph', children: [text] } : text;
    });
  };
  return (tree: MdNode) => walk(tree);
}

const PLUGINS = [remarkGfm, htmlAsText];

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
 * are glassbox's code blocks, cut out of the text first so each shows and copies whole. Only the
 * first `clip` characters of prose are parsed; "show all" opens the whole text as source.
 */
export const MarkdownRender = memo(function MarkdownRender({
  text,
  label,
  clip,
}: MarkdownProps & { clip: number }) {
  const { t } = useI18n();
  // Fenced code is cut out first: each block shows as a code block, whole, so it copies whole.
  const { parts, cut } = useMemo(() => clipSegments(text, clip), [text, clip]);
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
