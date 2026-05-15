import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  AnchorData,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  TextRangeAnchor,
  ElementPathAnchor,
  SerializableRect,
} from '@primer/shared';
import { useDocument } from '../queries/documents.ts';
import { useThreadsQuery } from '../queries/threads.ts';
import { useCreateThread } from '../queries/mutations.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { CommentSidebar } from '../components/CommentSidebar.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';

const MOCK_USER_ID = 'mock-user-1';

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

export function DocumentPage() {
  const { docId } = useParams();
  const docQuery = useDocument(docId ?? '');
  const latestVersionId = docQuery.data?.latestVersion.id ?? '';

  const threadsQuery = useThreadsQuery(latestVersionId);
  const threads = threadsQuery.data?.data.threads ?? [];
  const createThread = useCreateThread(latestVersionId);

  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [positionsByAnchorId, setPositionsByAnchorId] = useState<
    Map<string, { y: number; drifted: boolean }>
  >(new Map());

  const senderRef = useRef<((m: OutboundProtocolMessage) => void) | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);

  const anchorsForCompanion = useMemo(
    () => threads.map((t) => ({ id: t.id, data: t.anchor })),
    [threads]
  );

  const send = useCallback((msg: OutboundProtocolMessage) => {
    senderRef.current?.(msg);
  }, []);

  const registerSender = useCallback(
    (s: ((m: OutboundProtocolMessage) => void) | null) => {
      senderRef.current = s;
      if (s) {
        s({ type: 'update_anchors', anchors: anchorsForCompanion });
        s({ type: 'request_anchor_positions' });
      }
    },
    [anchorsForCompanion]
  );

  // Push fresh anchors whenever the threads set changes (after initial mount).
  useEffect(() => {
    const s = senderRef.current;
    if (!s) return;
    s({ type: 'update_anchors', anchors: anchorsForCompanion });
    s({ type: 'request_anchor_positions' });
  }, [anchorsForCompanion]);

  const onMessage = useCallback(
    (msg: InboundProtocolMessage) => {
      switch (msg.type) {
        case 'selection_captured':
          setPendingSelection({ anchor: msg.anchor, clientRects: msg.clientRects });
          setPendingPick(null);
          break;
        case 'element_picked':
          setPendingPick({ anchor: msg.anchor, clientRect: msg.clientRect });
          setPendingSelection(null);
          setPickMode(false);
          break;
        case 'pick_mode_exited':
          setPickMode(false);
          break;
        case 'anchor_positions':
          setPositionsByAnchorId(
            new Map(
              msg.positions.map((p) => [
                p.anchorId,
                {
                  y: p.rects[0]?.y ?? Number.POSITIVE_INFINITY,
                  drifted: p.drifted ?? false,
                },
              ])
            )
          );
          break;
        case 'open_external':
          if (isSafeExternalUrl(msg.url)) handleOpenExternal(msg);
          break;
        case 'resize':
          senderRef.current?.({ type: 'request_anchor_positions' });
          break;
      }
    },
    []
  );

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  const onHighlight = useCallback((anchorId: string) => {
    senderRef.current?.({ type: 'highlight_anchor', anchorId });
  }, []);

  const submitPending = async (body: string) => {
    const anchor: AnchorData | null = pendingSelection
      ? pendingSelection.anchor
      : pendingPick
      ? pendingPick.anchor
      : null;
    if (!anchor) return;
    await createThread.mutateAsync({ anchor, body });
    setPendingSelection(null);
    setPendingPick(null);
  };

  if (docQuery.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (docQuery.error) {
    return (
      <div className="text-red-600">
        Could not load document: {(docQuery.error as Error).message}
      </div>
    );
  }
  if (!docQuery.data) return null;

  const { document, latestVersion } = docQuery.data;

  // Floating "Add comment" pill near the selection rect.
  let pillPos: { left: number; top: number } | null = null;
  if (pendingSelection && pendingSelection.clientRects.length > 0) {
    const iframeEl = iframeWrapperRef.current?.querySelector('iframe');
    const iframeRect = iframeEl?.getBoundingClientRect();
    const r = pendingSelection.clientRects[0];
    pillPos = {
      left: (iframeRect?.left ?? 0) + r.x,
      top: (iframeRect?.top ?? 0) + r.y + r.height + 4,
    };
  }

  const composerPending = pendingSelection
    ? { anchor: pendingSelection.anchor as AnchorData }
    : pendingPick
    ? { anchor: pendingPick.anchor as AnchorData }
    : null;

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <header className="flex items-baseline justify-between border-b border-neutral-200 px-4 pb-2 pt-1">
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
              pickMode
                ? 'bg-red-600 text-white'
                : 'border border-neutral-300 hover:bg-neutral-100'
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

      <div className="flex flex-1 overflow-hidden">
        <div ref={iframeWrapperRef} className="flex-1 overflow-hidden">
          <ArtifactIframe
            src={`/api/versions/${latestVersion.id}/content`}
            anchors={anchorsForCompanion}
            onMessage={onMessage}
            registerSender={registerSender}
          />
        </div>
        <CommentSidebar
          versionId={latestVersion.id}
          currentUserId={MOCK_USER_ID}
          pending={composerPending}
          onCancelPending={() => {
            setPendingSelection(null);
            setPendingPick(null);
          }}
          onSubmitPending={submitPending}
          onHighlight={onHighlight}
          positionsByAnchorId={positionsByAnchorId}
        />
      </div>

      {pillPos && pendingSelection && composerPending && (
        <div
          style={{ position: 'fixed', left: pillPos.left, top: pillPos.top, zIndex: 1000 }}
          className="flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white shadow-lg"
        >
          <span>Add comment in sidebar →</span>
          <button
            type="button"
            onClick={() => setPendingSelection(null)}
            className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
