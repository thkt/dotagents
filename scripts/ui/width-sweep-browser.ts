/// <reference lib="dom" />
import type { z } from 'zod';
import type { boundaryShape, measurementShape } from './records.ts';

type Boundary = z.infer<typeof boundaryShape>;
type Measurement = z.infer<typeof measurementShape>;

// Playwrightが関数を直列化するため、モジュール内の外部変数には依存しない。
export function measureDOM(): Measurement {
  function selector(element: Element): string {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current) {
      const parent: Element | null = current.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1;
      parts.unshift(`${current.localName}:nth-child(${index})`);
      current = parent;
    }
    return parts.join(' > ');
  }
  function clipAncestors(element: Element) {
    const ancestors: Boundary['ancestors'] = [];
    let parent = element.parentElement;
    while (parent) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (
        overflowX === 'auto' ||
        overflowX === 'scroll' ||
        overflowX === 'hidden' ||
        overflowX === 'clip'
      ) {
        const rect = parent.getBoundingClientRect();
        ancestors.push({
          selector: selector(parent),
          overflowX,
          left: rect.left,
          right: rect.right,
        });
      }
      parent = parent.parentElement;
    }
    return ancestors;
  }
  const clientWidth = document.documentElement.clientWidth;
  const elements: Boundary[] = [];
  for (const element of document.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    if (rect.left < -1 || rect.right > clientWidth + 1) {
      elements.push({
        selector: selector(element),
        left: rect.left,
        right: rect.right,
        ancestors: clipAncestors(element),
      });
    }
  }
  return {
    innerWidth: window.innerWidth,
    clientWidth,
    scrollWidth: Math.max(
      document.documentElement.scrollWidth,
      document.scrollingElement?.scrollWidth ?? 0,
    ),
    elements,
  };
}

export async function settledDOM() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await document.fonts.ready;
        if (Array.from(document.fonts).some((font) => font.status === 'error')) {
          throw Error('Font loading failed');
        }
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Rendering did not settle')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
