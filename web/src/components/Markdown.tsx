import { Component, memo, type ReactNode, Suspense } from 'react';
import { useI18n } from '../i18n';
import { ChunkLoadError, lazyView } from '../lib/lazy-view';
import { ShowAll } from './CodeBlock';
import css from './Markdown.module.css';
import type { MarkdownProps } from './MarkdownRender';

/** Characters of prose rendered; past it "show all" opens the whole text as source. */
const CLIP = 6_000;

// The markdown parser is a quarter of the app's code: it loads the first time a reply is shown.
const Render = lazyView(() => import('./MarkdownRender').then((m) => m.MarkdownRender));

/** The text as written: while the renderer loads, or when it cannot render this text. */
function AsWritten({ text, label }: MarkdownProps) {
  return (
    <div className={css.markdown}>
      <p className={css.pending}>{text.slice(0, CLIP)}</p>
      {text.length > CLIP && <ShowAll label={label} text={text} />}
    </div>
  );
}

/** The renderer's code did not load: only a page load brings it back (React keeps the failure). */
function ChunkNote() {
  const { t } = useI18n();
  return (
    <p className={css.chunkNote}>
      {t('md.chunk')}{' '}
      <button type="button" className={css.reload} onClick={() => location.reload()}>
        {t('error.reload')}
      </button>
    </p>
  );
}

/**
 * A failure inside the renderer (its chunk did not load, say after a rebuild in an open tab, or
 * text nested thousands of levels deep) shows the text as written, here, instead of taking the
 * whole session view down with it. A chunk that did not load also says so, and offers Reload.
 */
class Fallback extends Component<
  { children: ReactNode; plain: ReactNode },
  { failed: Error | null }
> {
  override state: { failed: Error | null } = { failed: null };

  static getDerivedStateFromError(error: Error) {
    return { failed: error };
  }

  override render() {
    const { failed } = this.state;
    if (!failed) return this.props.children;
    return (
      <>
        {this.props.plain}
        {failed instanceof ChunkLoadError && <ChunkNote />}
      </>
    );
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
