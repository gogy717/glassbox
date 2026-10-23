import { lazy, memo, Suspense } from 'react';
import css from './Markdown.module.css';
import type { MarkdownProps } from './MarkdownRender';

/** Characters of prose rendered; past it "show all" opens the whole text as source. */
const CLIP = 6_000;

// The markdown parser is a quarter of the app's code: it loads the first time a reply is shown.
const Render = lazy(() => import('./MarkdownRender').then((m) => ({ default: m.MarkdownRender })));

/**
 * A model reply's markdown, rendered (see `MarkdownRender`). The renderer loads on first use;
 * until then the text shows as written.
 */
export const Markdown = memo(function Markdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<p className={css.pending}>{props.text.slice(0, CLIP)}</p>}>
      <Render {...props} clip={CLIP} />
    </Suspense>
  );
});
