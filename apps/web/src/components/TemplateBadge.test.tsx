import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import type { DocumentTemplate } from '@primer/shared';
import { TemplateBadge } from './TemplateBadge.tsx';

// The web package runs vitest in a `node` environment with no DOM / testing
// library, so we exercise this presentational component by invoking it as a
// function and inspecting the React element it returns.

const template: DocumentTemplate = {
  id: 'paperclip-punkify',
  label: 'Paperclip Punk',
  color: '#670DE5',
};

interface ElementProps {
  title?: string;
  'aria-label'?: string;
  style?: { backgroundColor?: string };
  children?: unknown;
}

function propsOf(node: unknown): ElementProps {
  return (node as ReactElement).props as ElementProps;
}

function flatten(children: unknown): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(flatten).join('');
  if (children && typeof children === 'object' && 'props' in (children as object)) {
    return flatten(propsOf(children).children);
  }
  return '';
}

describe('TemplateBadge', () => {
  it('renders the template label with a descriptive tooltip and aria-label', () => {
    const props = propsOf(TemplateBadge({ template }));
    expect(props.title).toBe('Built with the Paperclip Punk template');
    expect(props['aria-label']).toBe('Template: Paperclip Punk');
    expect(flatten(props.children)).toContain('Paperclip Punk');
  });

  it('tints the swatch with the template color', () => {
    const children = propsOf(TemplateBadge({ template })).children as unknown[];
    expect(propsOf(children[0]).style?.backgroundColor).toBe('#670DE5');
  });
});
