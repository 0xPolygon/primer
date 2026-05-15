import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  TextRangeAnchor,
  SerializableRect,
} from '@primer/shared';
import { useDocument } from '../queries/documents.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

export function DocumentPage() {
  const { docId } = useParams();
  const q = useDocument(docId ?? '');

  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const senderRef = useRef<((m: OutboundProtocolMessage) => void) | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);

  const send = useCallback((msg: OutboundProtocolMessage) => {
    senderRef.current?.(msg);
  }, []);

  const registerSender = useCallback(
    (s: ((m: OutboundProtocolMessage) => void) | null) => {
      senderRef.current = s;
    },
    []
  );

  const onMessage = useCallback(
    (msg: InboundProtocolMessage) => {
      switch (msg.type) {
        case 'selection_captured':
          setPending({ anchor: msg.anchor, clientRects: msg.clientRects });
          break;
        case 'element_picked': {
          const id = crypto.randomUUID();
          setAnchors((cur) => {
            const next = [...cur, { id, data: msg.anchor }];
            // Same-tick send so the companion gets the updated list.
            queueMicrotask(() =>
              senderRef.current?.({ type: 'update_anchors', anchors: next })
            );
            return next;
          });
          setPickMode(false);
          break;
        }
        case 'pick_mode_exited':
          setPickMode(false);
          break;
        case 'open_external':
          if (isSafeExternalUrl(msg.url)) handleOpenExternal(msg);
          break;
        case 'resize':
        case 'anchor_positions':
          // No UI consequence in this proto.
          break;
      }
    },
    []
  );

  const saveSelection = () => {
    if (!pending) return;
    const id = crypto.randomUUID();
    const next = [...anchors, { id, data: pending.anchor }];
    setAnchors(next);
    setPending(null);
    send({ type: 'update_anchors', anchors: next });
  };

  const dropAnchor = (id: string) => {
    const next = anchors.filter((a) => a.id !== id);
    setAnchors(next);
    send({ type: 'update_anchors', anchors: next });
  };

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  if (q.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (q.error) {
    return (
      <div className="text-red-600">
        Could not load document: {(q.error as Error).message}
      </div>
    );
  }
  if (!q.data) return null;

  const { document, latestVersion } = q.data;

  // Compute floating-button position from the pending selection's first rect.
  let buttonPos: { left: number; top: number } | null = null;
  if (pending && pending.clientRects.length > 0) {
    const iframeEl = iframeWrapperRef.current?.querySelector('iframe');
    const iframeRect = iframeEl?.getBoundingClientRect();
    const r = pending.clientRects[0];
    buttonPos = {
      left: (iframeRect?.left ?? 0) + r.x,
      top: (iframeRect?.top ?? 0) + r.y + r.height + 4,
    };
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between border-b border-neutral-200 pb-2">
        <div>
          <h1 className="text-xl font-semibold">{document.title}</h1>
          {document.description && (
            <p className="text-sm text-neutral-600">{document.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={togglePickMode}
            className={`rounded px-3 py-1 text-sm ${
              pickMode ? 'bg-red-600 text-white' : 'border border-neutral-300 hover:bg-neutral-100'
            }`}
          >
            {pickMode ? 'Exit pick mode' : 'Pick element'}
          </button>
          <div className="text-sm text-neutral-500">
            {document.uploaderDisplayName} ·{' '}
            {new Date(document.createdAt).toLocaleString()}
          </div>
        </div>
      </header>

      <div ref={iframeWrapperRef}>
        <ArtifactIframe
          src={`/api/versions/${latestVersion.id}/content`}
          anchors={anchors}
          onMessage={onMessage}
          registerSender={registerSender}
        />
      </div>

      {anchors.length > 0 && (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs">
          <div className="mb-1 text-neutral-600">
            {anchors.length} ephemeral anchor{anchors.length === 1 ? '' : 's'} (in-memory only)
          </div>
          <ul className="space-y-1">
            {anchors.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-neutral-700">
                  {a.data.type === 'text-range'
                    ? `"${a.data.selectorText.slice(0, 80)}"`
                    : a.data.path}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    onClick={() => send({ type: 'highlight_anchor', anchorId: a.id })}
                    className="rounded border border-neutral-300 px-2 hover:bg-white"
                  >
                    Highlight
                  </button>
                  <button
                    onClick={() => dropAnchor(a.id)}
                    className="rounded border border-neutral-300 px-2 hover:bg-white"
                  >
                    Drop
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {buttonPos && pending && (
        <div
          style={{ position: 'fixed', left: buttonPos.left, top: buttonPos.top, zIndex: 1000 }}
          className="rounded-md bg-neutral-900 text-white shadow-lg"
        >
          <button
            onClick={saveSelection}
            className="px-3 py-1.5 text-sm hover:bg-neutral-800 rounded-l-md"
          >
            Add comment
          </button>
          <button
            onClick={() => setPending(null)}
            aria-label="Dismiss"
            className="px-2 py-1.5 text-sm border-l border-neutral-700 hover:bg-neutral-800 rounded-r-md"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
