/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import { useBlockText, usePrimerBlockServices, type EmbedState } from './services.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** An http(s) link, or ''. The document is client-writable: no other scheme is ever linked. */
export function embedUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2000) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** A document id, or ''. */
export function embedDocumentId(raw: unknown): string {
  return typeof raw === 'string' && UUID.test(raw) ? raw.toLowerCase() : '';
}

/**
 * An embed: a link card or another Primer document. The server resolves both
 * (`GET /api/documents/:docId/embeds/:blockId`) and the browser never fetches
 * the linked page: a card is the page's title, description and one inlined
 * image. A document embed is resolved with the viewer's own permissions and
 * shows nothing to someone who can't read it. Exports and static renders carry
 * only the link, which needs no network and reveals nothing the viewer may
 * not see.
 */
export const embedBlock = createReactBlockSpec(
  {
    type: 'embed',
    propSchema: {
      url: { default: '' },
      /** Set when the embed is another Primer document (it wins over `url`). */
      documentId: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => <EmbedView {...(props as unknown as EmbedViewProps)} />,
    toExternalHTML: (props) => <EmbedLink url={embedUrl(props.block.props.url)} documentId={embedDocumentId(props.block.props.documentId)} />,
  },
);

type EmbedViewProps = {
  block: { id: string; props: { url: string; documentId: string } };
  editor: { isEditable: boolean; updateBlock(id: string, update: { props: Record<string, string> }): unknown };
};

/** Just the link: the static, Markdown and HTML form. */
function EmbedLink({ url, documentId }: { url: string; documentId: string }) {
  const text = useBlockText();
  if (documentId) {
    return (
      <p data-primer-embed="document">
        <a href={`/d/${documentId}`}>{text.embedDocument}</a>
      </p>
    );
  }
  return url ? (
    <p data-primer-embed="link">
      <a href={url}>{url}</a>
    </p>
  ) : (
    <p />
  );
}

const noEmbed = (): EmbedState => ({ status: 'none' });

function EmbedView({ block, editor }: EmbedViewProps) {
  const services = usePrimerBlockServices();
  const text = useBlockText();
  const url = embedUrl(block.props.url);
  const documentId = embedDocumentId(block.props.documentId);
  const state = (services?.useEmbed ?? noEmbed)(block.id, url, documentId);
  const set = (props: { url: string; documentId: string }) => editor.updateBlock(block.id, { props });

  // Static renders (no services): the link alone.
  if (!services) return <EmbedLink url={url} documentId={documentId} />;
  if (!url && !documentId) return editor.isEditable ? <EmbedForm onSubmit={set} /> : null;
  return (
    <div className="primer-embed" data-primer-embed={documentId ? 'document' : 'link'} contentEditable={false}>
      {state.status === 'loading' && <div className="primer-embed-note">{text.embedLoading}</div>}
      {state.status === 'none' && editor.isEditable && <div className="primer-embed-note">{text.embedUnavailable}</div>}
      {state.status === 'link' && <LinkCard card={state} />}
      {state.status === 'document' && <DocumentCard card={state} />}
      {editor.isEditable && (
        <button type="button" className="primer-embed-change" onClick={() => set({ url: '', documentId: '' })}>
          {text.embedChange}
        </button>
      )}
    </div>
  );
}

function LinkCard({ card }: { card: Extract<EmbedState, { status: 'link' }> }) {
  const href = embedUrl(card.url);
  if (!href) return null;
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    // embedUrl vetted it.
  }
  return (
    <a className="primer-embed-card" href={href} target="_blank" rel="noopener noreferrer">
      {card.image && INLINE_IMAGE.test(card.image) && <img className="primer-embed-image" src={card.image} alt="" />}
      <span className="primer-embed-text">
        <span className="primer-embed-title">{card.title || host}</span>
        {card.description && <span className="primer-embed-description">{card.description}</span>}
        <span className="primer-embed-site">{card.siteName || host}</span>
      </span>
    </a>
  );
}

function DocumentCard({ card }: { card: Extract<EmbedState, { status: 'document' }> }) {
  const text = useBlockText();
  const id = embedDocumentId(card.documentId);
  if (!id) return null;
  return (
    <a className="primer-embed-card primer-embed-document" href={`/d/${id}`}>
      <span className="primer-embed-text">
        <span className="primer-embed-site">{text.embedDocument}</span>
        <span className="primer-embed-title">{card.title}</span>
        {card.excerpt && <span className="primer-embed-description">{card.excerpt}</span>}
        <span className="primer-embed-site">{text.embedOpen}</span>
      </span>
    </a>
  );
}

/** What a pasted link means: one of this app's own documents, or any web link. */
export function parseEmbedInput(raw: string, origin: string): { url: string; documentId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin === origin) {
    const m = /^\/d\/([0-9a-f-]{36})(?:\/|$)/i.exec(parsed.pathname);
    if (m && UUID.test(m[1]!)) return { url: '', documentId: m[1]!.toLowerCase() };
  }
  return { url: parsed.href, documentId: '' };
}

function EmbedForm({ onSubmit }: { onSubmit: (props: { url: string; documentId: string }) => void }) {
  const text = useBlockText();
  const [value, setValue] = useState('');
  const parsed = parseEmbedInput(value, window.location.origin);
  return (
    <form
      className="primer-embed-form"
      contentEditable={false}
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed) onSubmit(parsed);
      }}
    >
      <input type="url" aria-label={text.embedPlaceholder} placeholder={text.embedPlaceholder} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" disabled={!parsed}>
        {text.embedAdd}
      </button>
    </form>
  );
}
