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
import { useVersionsQuery } from '../queries/versions.ts';
import { useThreadsQuery } from '../queries/threads.ts';
import { useCreateThread } from '../queries/mutations.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { CommentSidebar } from '../components/CommentSidebar.tsx';
import { VersionSelector } from '../components/VersionSelector.tsx';
import { EditableField } from '../components/EditableField.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';
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
  const { docId, versionNumber: versionNumberParam } = useParams();
  const navigate = useNavigate();
  const docQuery = useDocument(docId ?? '');
  const versionsQuery = useVersionsQuery(docId ?? '');
  const versions = versionsQuery.data?.versions ?? [];

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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const isUploader = docQuery.data?.document.uploaderDisplayName === 'Mock User';
  // In SP4 with the single mock user, every uploader check is effectively "is this the
  // mock user". SP5 will swap this for `docQuery.data?.document.uploaderId === user.id`
  // when the doc DTO exposes uploaderId.

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
      }
    },
    [readMostly]
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
              {pickMode ? 'Exit pick mode' : 'Pick element'}
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
          {isUploader && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm((s) => !s)}
                aria-label="More actions"
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                ⋯
              </button>
              {showDeleteConfirm && (
                <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md">
                  <p className="text-xs text-neutral-700">
                    Delete this document? You can restore it within 30 days from the home page.
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(false)}
                      className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteDoc.mutateAsync();
                        setShowDeleteConfirm(false);
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
      <AddVersionModal
        open={showAddVersion}
        preselectedDocId={docId}
        onClose={() => setShowAddVersion(false)}
      />
    </div>
  );
}
