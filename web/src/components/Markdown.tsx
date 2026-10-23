import { Component, lazy, memo, type ReactNode, Suspense } from 'react';
import { ShowAll } from './CodeBlock';
import css from './Markdown.module.css';
import type { MarkdownProps } from './MarkdownRender';

/** Characters of prose rendered; past it "show all" opens the whole text as source. */
const CLIP = 6_000;

// The markdown parser is a quarter of the app's code: it loads the first time a reply is shown.
const Render = lazy(() => import('./MarkdownRender').then((m) => ({ default: m.MarkdownRender })));

/** The text as written: while the renderer loads, or when it cannot render this text. */
function AsWritten({ text, label }: MarkdownProps) {
  return (
    <div className={css.markdown}>
      <p className={css.pending}>{text.slice(0, CLIP)}</p>
      {text.length > CLIP && <ShowAll label={label} text={text} />}
    </div>
  );
}

/**
 * A failure inside the renderer (its chunk did not load, say after a rebuild in an open tab, or
 * text nested thousands of levels deep) shows the text as written, here, instead of taking the
 * whole session view down with it.
 */
class Fallback extends Component<{ children: ReactNode; plain: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.plain : this.props.children;
  }
}

/**
 * A model reply's markdown, rendered (see `MarkdownRender`). The renderer loads on first use;
 * until then, and should it fail, the text shows as written.
 */
export const Markdown = memo(function Markdown(props: MarkdownProps) {
  const plain = <AsWritten {...props} />;
  return (
    <Fallback plain={plain}>
      <Suspense fallback={plain}>
        <Render {...props} clip={CLIP} />
      </Suspense>
    </Fallback>
  );
});
