import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Navigate, Link, useParams, useNavigate } from 'react-router-dom';
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
import { PrivateLockIcon } from '../components/PrivateLockIcon.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';
import { ShareModal } from '../components/ShareModal.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { useTheme } from '../lib/useTheme.ts';
import { commentsFilename, formatThreadsAsMarkdown, htmlFilename } from '../lib/exportComments.ts';
import { hasLiveComments } from '../lib/liveComments.ts';
import { BottomSheet, type SnapPoint } from '../components/BottomSheet.tsx';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { copyText } from '../lib/clipboardCopy.ts';
import { buildMenuItems, type MenuItemId } from '../lib/documentActionsMenu.ts';
import { extractCanonicalDocId } from '../lib/docIdParam.ts';
import {
  computePillPosition,
  type PillPosition,
} from '../lib/computePillPosition.ts';
import { useLibraryQuery } from '../queries/library.ts';
import { DocDetailFolderControl } from '../components/DocDetailFolderControl.tsx';

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

export function DocumentPage() {
  const { docId: rawDocId, versionNumber: versionNumberParam } = useParams();
  const canonicalDocId = rawDocId ? extractCanonicalDocId(rawDocId) : null;
  if (canonicalDocId && canonicalDocId !== rawDocId) {
    const target = versionNumberParam
      ? `/d/${canonicalDocId}/v/${versionNumberParam}`
      : `/d/${canonicalDocId}`;
    return <Navigate to={target} replace />;
  }
  return <DocumentPageInner />;
}

function DocumentPageInner() {
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
  const [showShare, setShowShare] = useState(false);
  const [actionsMenuState, setActionsMenuState] = useState<'closed' | 'menu' | 'confirm'>(
    'closed',
  );
  const [copyFeedback, setCopyFeedback] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);

  const COLLAPSED_KEY = 'primer.sidebar.collapsed';
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current !== null) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  const me = useMe();
  const libraryQ = useLibraryQuery();
  const libDoc = libraryQ.data?.documents.find((d) => d.id === docId);
  const currentFolder = libDoc?.folderId ? libraryQ.data?.folders.find((f) => f.id === libDoc.folderId) : null;
  const { effective: theme } = useTheme();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [sheetSnap, setSheetSnap] = useState<SnapPoint>('handle');
  const isUploader = !!me.data && me.data.id === docQuery.data?.document.uploaderId;

  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [positionsByAnchorId, setPositionsByAnchorId] = useState<
    Map<string, { y: number; drifted: boolean }>
  >(new Map());

  const senderRef = useRef<((m: OutboundProtocolMessage) => void) | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const [pillPos, setPillPos] = useState<PillPosition | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  // True iff the new-thread composer currently holds non-whitespace input.
  // Read by the iframe message handler to decide whether `selection_cleared`
  // should auto-dismiss a still-empty composer.
  const composerDirtyRef = useRef(false);

  const anchorsForCompanion = useMemo(
    () => threads.filter(hasLiveComments).map((t) => ({ id: t.id, data: t.anchor })),
    [threads]
  );

  const send = useCallback((msg: OutboundProtocolMessage) => {
    senderRef.current?.(msg);
  }, []);

  const onComposerDirtyChange = useCallback((dirty: boolean) => {
    composerDirtyRef.current = dirty;
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
        case 'selection_cleared':
          if (!composerDirtyRef.current) {
            setPendingSelection(null);
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
        case 'companion_log': {
          const fn = msg.level === 'error' ? console.error
                   : msg.level === 'warn'  ? console.warn
                   : console.log;
          // eslint-disable-next-line no-console
          fn('[companion]', msg.message);
          break;
        }
        case 'resize':
          senderRef.current?.({ type: 'request_anchor_positions' });
          break;
        case 'anchor_clicked':
          setFocusedThreadId(msg.anchorId);
          setSidebarCollapsed(false);
          setSheetSnap('peek');
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

  function showFeedback(
    fb: { kind: 'success' | 'error'; message: string },
    dismissMs: number = fb.kind === 'error' ? 3000 : 2000,
  ) {
    if (copyFeedbackTimerRef.current !== null) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopyFeedback(fb);
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopyFeedback(null);
      copyFeedbackTimerRef.current = null;
    }, dismissMs);
  }

  function openFullScreen() {
    if (!currentVersionId) return;
    window.open(
      `/api/versions/${currentVersionId}/content`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  async function downloadHtml() {
    if (!docQuery.data || !currentVersionId) return;
    try {
      const res = await fetch(`/api/versions/${currentVersionId}/content`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = htmlFilename(
        { title: docQuery.data.document.title },
        { versionNumber: currentVersionNumber },
      );
      a.style.display = 'none';
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      showFeedback({ kind: 'error', message: 'Download failed. Try again.' });
    }
  }

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

  async function copyComments() {
    if (!docQuery.data) return;
    const md = formatThreadsAsMarkdown(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
      threads,
    );
    const result = await copyText(md);
    showFeedback(
      result === 'failed'
        ? { kind: 'error', message: 'Copy failed. Try Download instead.' }
        : { kind: 'success', message: 'Copied' },
    );
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

  useEffect(() => {
    if (actionsMenuState !== 'menu') return;
    function onDown(e: MouseEvent) {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuState('closed');
      }
    }
    window.document.addEventListener('mousedown', onDown);
    return () => window.document.removeEventListener('mousedown', onDown);
  }, [actionsMenuState]);

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

  const composerPending = useMemo(
    () =>
      readMostly
        ? null
        : pendingSelection
          ? { anchor: pendingSelection.anchor as AnchorData }
          : pendingPick
            ? { anchor: pendingPick.anchor as AnchorData }
            : null,
    [readMostly, pendingSelection, pendingPick],
  );

  // Mobile sheet automation. No-op on desktop because the sheet isn't rendered.
  // Placed after composerPending so it can appear in the dependency array.
  useEffect(() => {
    if (!isMobile) return;
    if (pickMode) {
      setSheetSnap('handle');
    } else if (composerPending) {
      setSheetSnap('expanded');
    }
  }, [isMobile, pickMode, composerPending]);

  // Position the "Add comment in sidebar →" pill relative to the
  // selection. Recomputed whenever the selection's clientRects change
  // (mouseup + scroll-driven refreshes from the companion) or the host
  // window resizes. Two-pass measurement: first render uses a
  // conservative fallback size, then re-measures via pillRef.
  useLayoutEffect(() => {
    if (
      readMostly ||
      isMobile ||
      !pendingSelection ||
      pendingSelection.clientRects.length === 0
    ) {
      setPillPos(null);
      return;
    }
    const compute = () => {
      const iframe = iframeWrapperRef.current?.querySelector('iframe');
      if (!iframe) return;
      const pill = pillRef.current;
      const pillSize = pill
        ? { width: pill.offsetWidth, height: pill.offsetHeight }
        : { width: 220, height: 32 };
      const next = computePillPosition({
        rects: pendingSelection.clientRects,
        iframeRect: iframe.getBoundingClientRect(),
        pillSize,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setPillPos(next);
    };
    compute();
    window.addEventListener('resize', compute, { passive: true });
    return () => window.removeEventListener('resize', compute);
  }, [readMostly, isMobile, pendingSelection]);

  if (docQuery.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (docQuery.error) {
    return (
      <div className="text-red-600 dark:text-red-400">
        Could not load document: {(docQuery.error as Error).message}
      </div>
    );
  }
  if (!docQuery.data) return null;

  if (versionNotFound) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Version not found</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Version {requestedNumber} doesn't exist for this document.
        </p>
        <button
          type="button"
          onClick={() => navigate(`/d/${docId}`)}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Back to latest
        </button>
      </div>
    );
  }

  const { document } = docQuery.data;

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <header className="flex items-baseline justify-between gap-3 border-b border-neutral-200 px-3 sm:px-4 pb-2 pt-1 dark:border-neutral-800">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          {currentFolder && (
            <Link
              to={`/?folder=${encodeURIComponent(currentFolder.id)}`}
              className="mb-1 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              ← {currentFolder.name}
            </Link>
          )}
          <div className="flex items-center gap-2 min-w-0">
            {document.visibility === 'private' && (
              <PrivateLockIcon className="h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />
            )}
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
          </div>
          <EditableField
            value={document.description}
            placeholder="Add a description"
            canEdit={isUploader}
            multiline
            displayClassName="inline-block max-w-[60ch] break-words align-top text-sm text-neutral-600 dark:text-neutral-400"
            maxLength={2000}
            ariaLabel="Document description"
            onSave={async (next) => {
              await editDoc.mutateAsync({ description: next });
            }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {libDoc && (
            <DocDetailFolderControl
              docId={libDoc.id}
              currentFolderId={libDoc.folderId}
              currentFolderName={currentFolder?.name ?? null}
              folders={libraryQ.data?.folders ?? []}
            />
          )}
          {versions.length > 0 && (
            <VersionSelector
              docId={docId!}
              versions={versions}
              currentVersionNumber={currentVersionNumber}
              isViewingLatest={isViewingLatest}
              onAddVersion={
                isUploader && !readMostly ? () => setShowAddVersion(true) : undefined
              }
            />
          )}
          {!readMostly && (
            <button
              onClick={togglePickMode}
              className={`hidden md:inline-flex h-7 items-center rounded px-3 text-sm ${
                pickMode
                  ? 'bg-red-600 text-white'
                  : 'border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800'
              }`}
            >
              {pickMode ? 'Cancel' : 'Add Comment'}
            </button>
          )}
          {isUploader && (
            <button
              type="button"
              onClick={() => setShowShare(true)}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Share
            </button>
          )}
          <div className="relative" ref={actionsMenuRef}>
            <button
              type="button"
              onClick={() =>
                setActionsMenuState((s) => (s === 'closed' ? 'menu' : 'closed'))
              }
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={actionsMenuState !== 'closed'}
              className="inline-flex h-7 items-center rounded border border-neutral-300 bg-white px-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              ⋯
            </button>
            {actionsMenuState === 'menu' && (
              <div
                role="menu"
                className="absolute right-0 z-10 mt-1 w-56 overflow-hidden rounded border border-neutral-200 bg-white py-1 shadow-md dark:border-neutral-800 dark:bg-neutral-900"
              >
                {buildMenuItems({ isUploader }).map((item, index) => {
                  if (item.id === 'separator') {
                    return (
                      <div
                        key={`sep-${index}`}
                        className="my-1 border-t border-neutral-200 dark:border-neutral-800"
                        aria-hidden="true"
                      />
                    );
                  }
                  const onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void> = {
                    'open-fullscreen': () => {
                      setActionsMenuState('closed');
                      openFullScreen();
                    },
                    'download-html': () => {
                      setActionsMenuState('closed');
                      void downloadHtml();
                    },
                    copy: () => {
                      setActionsMenuState('closed');
                      void copyComments();
                    },
                    download: () => {
                      setActionsMenuState('closed');
                      exportComments();
                    },
                    delete: () => setActionsMenuState('confirm'),
                  };
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      onClick={onClickFor[item.id]}
                      className={`block w-full px-3 py-1.5 text-left text-xs ${
                        item.destructive
                          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
                          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
            {actionsMenuState === 'confirm' && (
              <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md dark:border-neutral-800 dark:bg-neutral-900">
                <p className="text-xs text-neutral-700 dark:text-neutral-300">
                  Delete this document? You can restore it within 30 days from the home page.
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setActionsMenuState('closed')}
                    className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
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
            {copyFeedback && (
              <div
                role="status"
                aria-live="polite"
                className={`absolute right-0 z-10 mt-1 rounded border px-2 py-1 text-xs shadow-md ${
                  copyFeedback.kind === 'success'
                    ? 'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
                    : 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400'
                }`}
              >
                {copyFeedback.message}
              </div>
            )}
          </div>
          <div className="hidden md:block text-sm text-neutral-500">
            {document.uploaderDisplayName} ·{' '}
            {new Date(document.createdAt).toLocaleString()}
          </div>
        </div>
      </header>

      {readMostly && (
        <div className="flex items-center justify-between border-b border-yellow-200 bg-yellow-50 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <span>
            You're viewing v{currentVersionNumber} of "{document.title}". This version is
            read-only. Switch to v{latestNumber} (latest) to add new comments.
          </span>
          <button
            type="button"
            onClick={() => navigate(`/d/${docId}`)}
            className="rounded border border-amber-700 px-2 py-0.5 text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"
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
            theme={theme}
            onMessage={onMessage}
            registerSender={registerSender}
          />
        </div>
        {!isMobile && (
          <CommentSidebar
            versionId={currentVersionId}
            currentUserId={me.data?.id ?? ''}
            pending={composerPending}
            onCancelPending={() => {
              setPendingSelection(null);
              setPendingPick(null);
            }}
            onSubmitPending={submitPending}
            onComposerDirtyChange={onComposerDirtyChange}
            onHighlight={onHighlight}
            positionsByAnchorId={positionsByAnchorId}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
            focusedThreadId={focusedThreadId}
          />
        )}
      </div>

      {isMobile && (
        <BottomSheet
          snap={sheetSnap}
          onSnapChange={(next) => {
            if (pickMode && next !== 'handle') {
              // User tried to expand the sheet while picking — interpret as cancel.
              send({ type: 'exit_pick_mode' });
              setPickMode(false);
              setSheetSnap('handle');
              return;
            }
            setSheetSnap(next);
          }}
          dragLocked={composerPending !== null}
          showBackdrop
          handleLabel={
            pickMode
              ? 'Picking element… (tap to cancel)'
              : `💬 ${threads.filter(hasLiveComments).length} comments`
          }
        >
          <CommentSidebar
            versionId={currentVersionId}
            currentUserId={me.data?.id ?? ''}
            pending={composerPending}
            onCancelPending={() => {
              setPendingSelection(null);
              setPendingPick(null);
            }}
            onSubmitPending={submitPending}
            onComposerDirtyChange={onComposerDirtyChange}
            onHighlight={onHighlight}
            positionsByAnchorId={positionsByAnchorId}
            focusedThreadId={focusedThreadId}
            onAddCommentClick={readMostly ? undefined : togglePickMode}
            addCommentActive={readMostly ? false : pickMode}
          />
        </BottomSheet>
      )}

      {!isMobile && pendingSelection && composerPending && (
        <div
          ref={pillRef}
          style={{
            position: 'fixed',
            left: pillPos?.left ?? 0,
            top: pillPos?.top ?? 0,
            zIndex: 1000,
            visibility:
              pillPos && !pillPos.hidden ? 'visible' : 'hidden',
          }}
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
      {showShare && docId && (
        <ShareModal open docId={docId} onClose={() => setShowShare(false)} />
      )}
    </div>
  );
}
