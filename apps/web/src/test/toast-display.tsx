import { Fragment, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Assert the visible toast copy, including localized React nodes, not its representation. */
export function toastDisplay(payload: unknown) {
  if (!payload || typeof payload !== 'object') return payload;
  const visible = (node: unknown) => {
    if (node == null || typeof node === 'string') return node;
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(createElement(Fragment, null, node as ReactNode));
    return container.textContent;
  };
  const result = { ...payload } as Record<string, unknown>;
  for (const field of ['title', 'description']) {
    if (field in result) result[field] = visible(result[field]);
  }
  return result;
}
