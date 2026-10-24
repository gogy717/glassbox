import { type ComponentType, type LazyExoticComponent, lazy } from 'react';

/**
 * A view's code that did not load. React.lazy keeps the failed import, so rendering again throws
 * it again; after an upgrade an open tab asks for chunks that are gone. Only a page load helps.
 */
export class ChunkLoadError extends Error {
  override name = 'ChunkLoadError';
}

/** React.lazy for a view loaded on first use, whose failure the ErrorBoundary meets with Reload. */
export function lazyView<P extends object>(
  load: () => Promise<ComponentType<P>>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    load().then(
      (component) => ({ default: component }),
      (error: unknown) => {
        throw new ChunkLoadError(error instanceof Error ? error.message : String(error), {
          cause: error,
        });
      },
    ),
  );
}
