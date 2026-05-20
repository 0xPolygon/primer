import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type {
  AnchorData,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  TextRangeAnchor,
  ElementPathAnchor,
  SerializableRect,
} from '@primer/shared';
import { useDocument, useDeleteDocument, useEditDocument } from '../queries/documents.ts';
import { useMe } from '../queries/me.ts';
import { useVersionsQuery } from '../queries/versions.ts';
import { useThreadsQuery } from '../queries/threads.ts';
import { useCreateThread } from '../queries/mutations.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { CommentSidebar } from '../components/CommentSidebar.tsx';
import { VersionSelector } from '../components/VersionSelector.tsx';
import { EditableField } from '../components/EditableField.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { commentsFilename, formatThreadsAsMarkdown } from '../lib/exportComments.ts';

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

export function DocumentPage() {
  const { docId, versionNumber: versionNumberParam } = useParams();
  const navigate = useNavigate();
  const docQuery = useDocument(docId ?? '');
  const versionsQuery = useVersionsQuery(docId ?? '');
  const versions = versionsQuery.data?.versions ?? [];

  useDocumentTitle(docQuery.data?.document.title);

  const requestedNumber = versionNumberParam ? Number(versionNumberParam) : undefined;
  const latestVersion = versions[0];
  const latestNumber = latestVersion?.versionNumber;

  const pinnedVersion = useMemo(() => {
    if (requestedNumber === undefined) return undefined;
    return versions.find((v) => v.versionNumber === requestedNumber);
  }, [versions, requestedNumber]);

  // The version we're actually viewing: pinned if requested+found, else latest.
  const currentVersion = pinnedVersion ?? latestVersion;
  const currentVersionId = currentVersion?.id ?? '';
  const currentVersionNumber = currentVersion?.versionNumber ?? 1;
  const isViewingLatest =
    !requestedNumber || (latestNumber !== undefined && requestedNumber === latestNumber);
  const readMostly = !isViewingLatest;

  // Handle "version not found" — requested a number that doesn't exist.
  const versionNotFound =
    requestedNumber !== undefined && versionsQuery.isSuccess && !pinnedVersion;

  const threadsQuery = useThreadsQuery(currentVersionId);
  const threads = threadsQuery.data?.data.threads ?? [];
  const createThread = useCreateThread(currentVersionId);

  const editDoc = useEditDocument(docId ?? '');
  const deleteDoc = useDeleteDocument(docId ?? '');

  const [showAddVersion, setShowAddVersion] = useState(false);
  const [actionsMenuState, setActionsMenuState] = useState<'closed' | 'menu' | 'confirm'>(
    'closed',
  );

  const COLLAPSED_KEY = 'primer.sidebar.collapsed';
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const me = useMe();
  const isUploader = !!me.data && me.data.id === docQuery.data?.document.uploaderId;

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

  useEffect(() => {
    setPositionsByAnchorId(new Map());
    setFocusedThreadId(null);
  }, [currentVersionId]);

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
          if (!readMostly) {
            setPendingSelection({ anchor: msg.anchor, clientRects: msg.clientRects });
            setPendingPick(null);
          }
          break;
        case 'element_picked':
          if (!readMostly) {
            setPendingPick({ anchor: msg.anchor, clientRect: msg.clientRect });
            setPendingSelection(null);
            setPickMode(false);
          }
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
        case 'anchor_clicked':
          setFocusedThreadId(msg.anchorId);
          setSidebarCollapsed(false);
          requestAnimationFrame(() => {
            window.document.getElementById(`thread-${msg.anchorId}`)?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          });
          break;
      }
    },
    [readMostly]
  );

  function exportComments() {
    if (!docQuery.data) return;
    const md = formatThreadsAsMarkdown(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
      threads,
    );
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = commentsFilename(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
    );
    a.style.display = 'none';
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  // Sticky-focus state — null = no thread focused. Sidebar threads can set it
  // (click or composer mount). Companion paints the focused anchor and keeps
  // it painted until we send a new value.
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);

  // Push focus changes to the companion. Re-pushes on version change too so
  // the new iframe picks up the existing focus on mount.
  useEffect(() => {
    senderRef.current?.({ type: 'set_focused_anchor', anchorId: focusedThreadId });
  }, [focusedThreadId, currentVersionId]);

  const onHighlight = useCallback((anchorId: string) => {
    setFocusedThreadId(anchorId);
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/^#thread-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (!match) return;
    const threadId = match[1];
    if (!threadsQuery.isSuccess) return;
    const found = threads.find((t) => t.id === threadId);
    if (!found) return;

    setSidebarCollapsed(false);

    // Defer to next frame so the sidebar transition starts + the DOM is ready.
    requestAnimationFrame(() => {
      window.document.getElementById(`thread-${threadId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      onHighlight(threadId);
    });

    // Clear the hash so a manual refresh doesn't re-fire.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [threadsQuery.isSuccess, threads, onHighlight]);

  const submitPending = async (body: string, mentions: string[]) => {
    const anchor: AnchorData | null = pendingSelection
      ? pendingSelection.anchor
      : pendingPick
      ? pendingPick.anchor
      : null;
    if (!anchor) return;
    await createThread.mutateAsync({ anchor, body, mentions });
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

  if (versionNotFound) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Version not found</h1>
        <p className="text-sm text-neutral-600">
          Version {requestedNumber} doesn't exist for this document.
        </p>
        <button
          type="button"
          onClick={() => navigate(`/d/${docId}`)}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
        >
          Back to latest
        </button>
      </div>
    );
  }

  const { document } = docQuery.data;
  const composerPending = readMostly
    ? null
    : pendingSelection
      ? { anchor: pendingSelection.anchor as AnchorData }
      : pendingPick
        ? { anchor: pendingPick.anchor as AnchorData }
        : null;

  let pillPos: { left: number; top: number } | null = null;
  if (!readMostly && pendingSelection && pendingSelection.clientRects.length > 0) {
    const iframeEl = iframeWrapperRef.current?.querySelector('iframe');
    const iframeRect = iframeEl?.getBoundingClientRect();
    const r = pendingSelection.clientRects[0];
    pillPos = {
      left: (iframeRect?.left ?? 0) + r.x,
      top: (iframeRect?.top ?? 0) + r.y + r.height + 4,
    };
  }

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <header className="flex items-baseline justify-between border-b border-neutral-200 px-4 pb-2 pt-1">
        <div>
          <EditableField
            value={document.title}
            placeholder="Add a title"
            canEdit={isUploader}
            displayClassName="text-xl font-semibold"
            maxLength={200}
            ariaLabel="Document title"
            onSave={async (next) => {
              if (next === null || next.trim().length === 0) {
                throw new Error('Title cannot be empty');
              }
              await editDoc.mutateAsync({ title: next });
            }}
          />
          <EditableField
            value={document.description}
            placeholder="Add a description"
            canEdit={isUploader}
            multiline
            displayClassName="text-sm text-neutral-600"
            maxLength={2000}
            ariaLabel="Document description"
            onSave={async (next) => {
              await editDoc.mutateAsync({ description: next });
            }}
          />
        </div>
        <div className="flex items-center gap-3">
          {versions.length > 0 && (
            <VersionSelector
              docId={docId!}
              versions={versions}
              currentVersionNumber={currentVersionNumber}
              isViewingLatest={isViewingLatest}
            />
          )}
          {!readMostly && (
            <button
              onClick={togglePickMode}
              className={`rounded px-3 py-1 text-sm ${
                pickMode
                  ? 'bg-red-600 text-white'
                  : 'border border-neutral-300 hover:bg-neutral-100'
              }`}
            >
              {pickMode ? 'Cancel' : 'Add Comment'}
            </button>
          )}
          {isUploader && !readMostly && (
            <button
              type="button"
              onClick={() => setShowAddVersion(true)}
              className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              + Version
            </button>
          )}
          <button
            type="button"
            onClick={exportComments}
            title="Download comments as Markdown"
            className="inline-flex items-center gap-1 rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export
          </button>
          {isUploader && (
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setActionsMenuState((s) => (s === 'closed' ? 'menu' : 'closed'))
                }
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={actionsMenuState !== 'closed'}
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                ⋯
              </button>
              {actionsMenuState === 'menu' && (
                <div
                  role="menu"
                  className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded border border-neutral-200 bg-white py-1 shadow-md"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setActionsMenuState('confirm')}
                    className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
                  >
                    Delete document…
                  </button>
                </div>
              )}
              {actionsMenuState === 'confirm' && (
                <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md">
                  <p className="text-xs text-neutral-700">
                    Delete this document? You can restore it within 30 days from the home page.
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setActionsMenuState('closed')}
                      className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteDoc.mutateAsync();
                        setActionsMenuState('closed');
                        navigate('/');
                      }}
                      className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="text-sm text-neutral-500">
            {document.uploaderDisplayName} ·{' '}
            {new Date(document.createdAt).toLocaleString()}
          </div>
        </div>
      </header>

      {readMostly && (
        <div className="flex items-center justify-between border-b border-yellow-200 bg-yellow-50 px-4 py-1.5 text-xs text-amber-900">
          <span>
            You're viewing v{currentVersionNumber} of "{document.title}". This version is
            read-only. Switch to v{latestNumber} (latest) to add new comments.
          </span>
          <button
            type="button"
            onClick={() => navigate(`/d/${docId}`)}
            className="rounded border border-amber-700 px-2 py-0.5 text-amber-900 hover:bg-amber-100"
          >
            Switch to latest
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div ref={iframeWrapperRef} className="flex-1 overflow-hidden">
          <ArtifactIframe
            src={`/api/versions/${currentVersionId}/content`}
            anchors={anchorsForCompanion}
            onMessage={onMessage}
            registerSender={registerSender}
          />
        </div>
        <CommentSidebar
          versionId={currentVersionId}
          currentUserId={me.data?.id ?? ''}
          pending={composerPending}
          onCancelPending={() => {
            setPendingSelection(null);
            setPendingPick(null);
          }}
          onSubmitPending={submitPending}
          onHighlight={onHighlight}
          positionsByAnchorId={positionsByAnchorId}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          focusedThreadId={focusedThreadId}
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
      <AddVersionModal
        open={showAddVersion}
        preselectedDocId={docId}
        preselectedDocTitle={document.title}
        onClose={() => setShowAddVersion(false)}
      />
    </div>
  );
}
