import { afterEach, beforeEach, onTestFinished } from 'vitest';

/** For one test, every h2 holds more than it shows, as a line-clamped long prompt does. */
export function clampHeadings(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === 'H2' ? this.clientHeight + 40 : 0;
    },
  });
  onTestFinished(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  });
}

type SizeProp = 'offsetHeight' | 'offsetWidth' | 'clientHeight' | 'clientWidth';

/**
 * jsdom has no layout, so virtualised lists see a 0 px viewport. Give every element a size so
 * virtualizers render all rows of short demo lists: rows (`data-index`) are 100 px tall,
 * everything else is `height` tall.
 */
export function useFakeLayout(height = 4000, width = 1200): void {
  const props: SizeProp[] = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'];
  const saved = new Map<SizeProp, PropertyDescriptor | undefined>();
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const sizeOf = (el: HTMLElement, prop: SizeProp) =>
    prop.endsWith('Width') ? width : el.dataset.index ? 100 : height;

  beforeEach(() => {
    for (const prop of props) {
      saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get() {
          return sizeOf(this as HTMLElement, prop);
        },
      });
    }
    HTMLElement.prototype.getBoundingClientRect = function () {
      return DOMRect.fromRect({ width, height: sizeOf(this, 'offsetHeight') });
    };
  });
  afterEach(() => {
    for (const prop of props) {
      const d = saved.get(prop);
      if (d) Object.defineProperty(HTMLElement.prototype, prop, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });
}
