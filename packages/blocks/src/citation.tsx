/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { createReactInlineContentSpec } from '@blocknote/react';

/**
 * Evidence provenance (M10b.4): a claim's source, inline. A citation names a
 * web page (`url`) or a Primer document (`docId`, pinned to the version
 * cited, `versionNumber`), with the `quote` that supports the claim. It
 * renders as a numbered chip (a CSS counter, so numbers follow reading order
 * in the editor, static pages and email alike) labelled with the source.
 *
 * Every prop is writable by anyone who can edit the document: a link is only
 * ever http(s) or a Primer document path built from a valid id, and the
 * server checks access before it says anything about a cited document.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CitationProps = { url: string; docId: string; versionNumber: string; quote: string };

/** Where a citation links, or null when its props name nothing safe. */
export function citationHref(props: CitationProps): string | null {
  if (UUID.test(props.docId)) {
    return /^[1-9]\d{0,8}$/.test(props.versionNumber) ? `/d/${props.docId}/v/${props.versionNumber}` : `/d/${props.docId}`;
  }
  try {
    const url = new URL(props.url);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The chip's label: the site, or "Primer" with the cited version. */
export function citationLabel(props: CitationProps): string {
  if (UUID.test(props.docId)) return /^[1-9]\d{0,8}$/.test(props.versionNumber) ? `Primer v${props.versionNumber}` : 'Primer';
  try {
    return new URL(props.url).hostname.replace(/^www\./, '') || 'source';
  } catch {
    return 'source';
  }
}

export const citationChip = createReactInlineContentSpec(
  {
    type: 'citation',
    propSchema: { url: { default: '' }, docId: { default: '' }, versionNumber: { default: '' }, quote: { default: '' } },
    content: 'none',
  },
  {
    render: ({ inlineContent }) => {
      const props = inlineContent.props as CitationProps;
      const href = citationHref(props);
      const label = citationLabel(props);
      return (
        <sup className="primer-chip primer-citation" title={props.quote || undefined} data-citation="">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          ) : (
            label
          )}
        </sup>
      );
    },
  },
);
