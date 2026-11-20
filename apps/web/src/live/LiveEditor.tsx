import { useEffect, useMemo, useState } from 'react';
import { BlockNoteViewEditor, useCreateBlockNote } from '@blocknote/react';
import { insertOrUpdateBlockForSlashMenu } from '@blocknote/core/extensions';
import { VersioningSidebar } from '@blocknote/react/versioning';
import { BlockNoteView } from '@blocknote/ariakit';
import { withCollaboration, YjsVersioningExtension } from '@blocknote/core/yjs';
import { createExtension } from '@blocknote/core';
import { CommentsExtension } from '@blocknote/core/comments';
import { ThreadsSidebar } from '@blocknote/react';
import { PrimerBlocksContext, primerSchema, type DataTableBlockProps, type WidgetBlockProps } from '@primer/blocks';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/ariakit/style.css';
import type { CatchUpSince, DocFileUploadResponse, Target, ViewerRole } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { ConnectionStatus } from './ConnectionStatus.tsx';
import { AgentStatus } from './AgentStatus.tsx';
import { createLiveProvider, type LiveProvider } from './provider.ts';
import { editorDictionary, t } from '../i18n/index.ts';
import { ChipMenus } from './ChipMenus.tsx';
import { routeMarkdownPasteToServer } from './paste.ts';
import { PrimerVersionStorage } from './versionStorage.ts';
import { TabStrip, useTabs } from './TabStrip.tsx';
import { MAIN_TAB, tabFragmentName } from './tabs.ts';
import { PrimerThreadStore } from './PrimerThreadStore.ts';
import { commentDeleteGuard, type HeldDelete } from './commentDeleteGuard.ts';
import { DeleteCommentedDialog } from './DeleteCommentedDialog.tsx';
import { useThreadEvents } from './threadEvents.ts';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';
import { ThreadActions } from './ThreadActions.tsx';
import { CatchUpPanel, ChangeHighlights, useCheckpointChanges } from './changes.tsx';
import { useBlockServices, type ChoiceStore } from './blockServices.ts';
import { DecisionRegister } from './DecisionRegister.tsx';
import { PageView } from './PageView.tsx';
import { WidgetView } from './WidgetView.tsx';
import { DataTableView, type DataTableViewProps } from './DataTableView.tsx';
import './blocks.css';

export type LiveEditorProps = {
  documentId: string;
  readOnly: boolean;
  /** Whether this viewer may vote on choices (owner, editor or responder). */
  canVote: boolean;
  theme: 'light' | 'dark';
  /** Shown on this viewer's cursor to everyone else. */
  userName: string;
  userId: string;
  role: ViewerRole;
  canComment: boolean;
  /** Opens a version from before the document went live in the version viewer. */
  onOpenLegacyVersion?: (versionNumber: number) => void;
  /** The viewer's previous visit (document detail `lastView`): catch-up shows what changed since. */
  lastView?: CatchUpSince | null;
};

/**
 * A live document in BlockNote, synced over `/collab`, one editor per tab: stock blocks, the
 * Ariakit UI (slash menu, formatting toolbar, side menu, table handles, file
 * panel), collaboration cursors and BlockNote's version history over Primer's
 * checkpoints. Files upload to the document and are stored as opaque
 * `primer-blob://` ids, resolved to an authorised link at read time.
 */
export default function LiveEditor(props: LiveEditorProps) {
  // The connection is made and torn down by one effect, so a remount (React
  // runs effects twice in development) never reuses a destroyed provider.
  const [live, setLive] = useState<LiveProvider | null>(null);
  useEffect(() => {
    const created = createLiveProvider(props.documentId);
    setLive(created);
    return () => created.destroy();
  }, [props.documentId]);
  if (!live) return null;
  return <LiveEditorView key={live.doc.guid} live={live} {...props} />;
}

function LiveEditorView(props: LiveEditorProps & { live: LiveProvider }) {
  const tabs = useTabs(props.live.doc);
  const [selected, setSelected] = useState(MAIN_TAB);
  // A tab someone else deleted falls back to the first.
  const active = tabs.some((t) => t.id === selected) ? selected : MAIN_TAB;
  // Choice and task blocks reach the API through these (people pick; the
  // browser is always a person's session).
  const { services, store } = useBlockServices(props.documentId, { canPick: !props.readOnly, canVote: props.canVote });
  // Taken once: a refetch of the document records a newer visit.
  const [since] = useState(() => props.lastView ?? null);
  const [catchUp, setCatchUp] = useState<Target[]>([]);
  // Page, widget and data-table blocks render their views and overlay through the block services.
  const { live, documentId, readOnly, theme, userId, role, userName, canVote, canComment } = props;
  const withPages = useMemo(() => {
    const context = {
      doc: live.doc,
      documentId,
      tabId: active,
      canEdit: !readOnly,
      theme,
      viewer: { id: userId, isOwner: role === 'owner', canComment, name: userName },
    };
    const BoundPageView = (p: { blockId: string; title: string }) => <PageView {...context} {...p} />;
    const BoundWidgetView = (p: { blockId: string; props: WidgetBlockProps }) => <WidgetView {...context} {...p} />;
    // Records are written by whoever may vote (owner, editor, responder).
    const BoundDataTableView = (p: { blockId: string; props: DataTableBlockProps; update: DataTableViewProps['update'] }) => (
      <DataTableView {...context} {...p} canWrite={canVote} />
    );
    return { ...services, PageView: BoundPageView, WidgetView: BoundWidgetView, DataTableView: BoundDataTableView };
  }, [services, live.doc, documentId, active, readOnly, theme, userId, role, userName, canVote, canComment]);
  return (
    <PrimerBlocksContext.Provider value={withPages}>
      <div className="flex h-full flex-col" data-live-editor={props.documentId}>
        <ConnectionStatus provider={props.live.provider} />
        <AgentStatus provider={props.live.provider} />
        <TabStrip doc={props.live.doc} tabs={tabs} active={active} onSelect={setSelected} readOnly={props.readOnly} />
        {since && <CatchUpPanel documentId={props.documentId} since={since} onBlocks={setCatchUp} />}
        {/* One editor per tab fragment, mounted when its tab is opened. */}
        <TabEditor key={active} tabId={active} store={store} catchUp={catchUp} {...props} />
      </div>
    </PrimerBlocksContext.Provider>
  );
}

function TabEditor({
  live,
  tabId,
  documentId,
  readOnly,
  theme,
  userName,
  userId,
  role,
  canComment,
  onOpenLegacyVersion,
  store,
  catchUp,
}: LiveEditorProps & { live: LiveProvider; tabId: string; store: ChoiceStore; catchUp: Target[] }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOn, setChangesOn] = useState(false);
  const sinceCheckpoint = useCheckpointChanges(documentId, tabId, changesOn);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [held, setHeld] = useState<HeldDelete | null>(null);
  const threadStore = useMemo(
    () =>
      new PrimerThreadStore(documentId, tabId, {
        id: userId,
        isOwner: role === 'owner',
        canComment,
      }),
    [documentId, tabId, userId, role, canComment],
  );
  useThreadEvents(documentId, () => void threadStore.refresh());

  const editor = useCreateBlockNote(
    withCollaboration({
      schema: primerSchema,
      extensions: [
        // Comments on Primer's threads; the server writes their marks.
        CommentsExtension({
          threadStore,
          resolveUsers: async (ids: string[]) =>
            ids.map((id) => {
              const username = threadStore.names.get(id) ?? id;
              return { id, username, avatarUrl: initialsAvatar(username) };
            }),
        }),
        createExtension({
          key: 'primerCommentDeleteGuard',
          prosemirrorPlugins: [
            commentDeleteGuard({
              openThreadIds: () => threadStore.openThreadIds(),
              quoteOf: (id) => threadStore.quoteOf(id),
              onHold: setHeld,
              dispatch: (tr) => threadStore.editor?._tiptapEditor.view.dispatch(tr),
              currentDoc: () => threadStore.editor!.prosemirrorState.doc,
            }),
          ],
        }),
        YjsVersioningExtension({ storage: new PrimerVersionStorage(documentId, onOpenLegacyVersion) }),
      ],
      collaboration: {
        provider: { awareness: live.provider.awareness ?? undefined },
        fragment: live.doc.getXmlFragment(tabFragmentName(tabId)),
        user: { name: userName, color: colorFor(userName) },
      },
      dictionary: editorDictionary(),
      uploadFile: async (file: File) => {
        const form = new FormData();
        form.append('file', file);
        const res = await api(`/api/documents/${documentId}/files`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
        return ((await res.json()) as DocFileUploadResponse).url;
      },
      resolveFileUrl: async (url: string) =>
        url.startsWith('primer-blob://')
          ? `/api/files/${encodeURIComponent(url.slice('primer-blob://'.length))}?doc=${encodeURIComponent(documentId)}`
          : url,
    }),
    [live, tabId, threadStore],
  );
  useEffect(() => {
    threadStore.editor = editor;
    void threadStore.refresh();
  }, [editor, threadStore]);
  useEffect(() => routeMarkdownPasteToServer(editor), [editor]);

  return (
    <>
      <div className="flex items-center justify-end gap-2 px-4 pt-2">
        <button
          type="button"
          onClick={() => setCommentsOpen((open) => !open)}
          aria-pressed={commentsOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('liveEditor.comments')}
        </button>
        <button
          type="button"
          onClick={() => setSuggestionsOpen((open) => !open)}
          aria-pressed={suggestionsOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {suggestionCount > 0 ? t('liveEditor.suggestionsCount', { count: suggestionCount }) : t('liveEditor.suggestions')}
        </button>
        <button
          type="button"
          onClick={() => setDecisionsOpen((open) => !open)}
          aria-pressed={decisionsOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('liveEditor.decisions')}
        </button>
        <button
          type="button"
          onClick={() => setChangesOn((on) => !on)}
          aria-pressed={changesOn}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('liveEditor.changes')}
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-pressed={historyOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('liveEditor.history')}
        </button>
      </div>
      <ChangeHighlights tone="catchup" blockIds={catchUp.filter((b) => b.tabId === tabId).map((b) => b.blockId)} />
      {sinceCheckpoint && <ChangeHighlights tone="checkpoint" blockIds={sinceCheckpoint} />}
      <BlockNoteView editor={editor} editable={!readOnly} theme={theme} renderEditor={false} slashMenu={false} className="flex min-h-0 flex-1">
        <ChipMenus editor={editor} slashItems={primerSlashItems(editor)} />
        <div className="min-w-0 flex-1 overflow-y-auto py-4">
          <BlockNoteViewEditor />
        </div>
        {commentsOpen && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 p-2 dark:border-neutral-800" data-threads-sidebar>
            <select
              aria-label={t('liveEditor.showComments')}
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              className="mb-2 h-7 rounded border border-neutral-300 bg-transparent px-2 text-xs dark:border-neutral-700"
            >
              <option value="open">{t('liveEditor.filterOpen')}</option>
              <option value="resolved">{t('liveEditor.filterResolved')}</option>
              <option value="all">{t('liveEditor.filterAll')}</option>
            </select>
            <ThreadsSidebar filter={filter} />
            <ThreadActions store={threadStore} canPromote />
          </div>
        )}
        <div
          hidden={!suggestionsOpen}
          className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 p-2 dark:border-neutral-800"
        >
          <SuggestionsPanel
            documentId={documentId}
            tabId={tabId}
            canDecide={role === 'owner' || role === 'editor'}
            onCount={setSuggestionCount}
            onShow={(blockId) => editor.setTextCursorPosition(blockId, 'start')}
          />
        </div>
        {decisionsOpen && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 dark:border-neutral-800">
            <DecisionRegister documentId={documentId} store={store} onClose={() => setDecisionsOpen(false)} />
          </div>
        )}
        {historyOpen && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 dark:border-neutral-800">
            <VersioningSidebar onClose={() => setHistoryOpen(false)} />
          </div>
        )}
      </BlockNoteView>
      {held && <DeleteCommentedDialog held={held} onClose={() => setHeld(null)} />}
    </>
  );
}

/** A small initials badge, so comments need no avatar service. */
function initialsAvatar(name: string): string {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="${colorFor(name)}"/><text x="16" y="21" font-family="sans-serif" font-size="13" fill="white" text-anchor="middle">${initials.replace(/[<>&"]/g, '')}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Slash menu entries for Primer's own blocks. */
function primerSlashItems(editor: unknown) {
  const insert = (block: object) => () => insertOrUpdateBlockForSlashMenu(editor as never, block as never);
  return [
    {
      title: t('slash.choice'),
      subtext: t('slash.choiceHint'),
      aliases: ['choice', 'decision', 'vote', 'poll', 'options'],
      group: t('slash.group'),
      onItemClick: insert({
        type: 'choice',
        children: [
          { type: 'choiceOption', children: [{ type: 'paragraph' }] },
          { type: 'choiceOption', children: [{ type: 'paragraph' }] },
        ],
      }),
    },
    {
      title: t('slash.task'),
      subtext: t('slash.taskHint'),
      aliases: ['task', 'todo', 'assign', 'action'],
      group: t('slash.group'),
      onItemClick: insert({ type: 'task' }),
    },
    {
      title: t('slash.callout'),
      subtext: t('slash.calloutHint'),
      aliases: ['callout', 'alert', 'note', 'warning', 'info', 'admonition'],
      group: t('slash.blocksGroup'),
      onItemClick: insert({ type: 'callout', props: { kind: 'info' } }),
    },
    {
      title: t('slash.columns'),
      subtext: t('slash.columnsHint'),
      aliases: ['columns', 'column', 'layout', 'side by side', 'grid'],
      group: t('slash.blocksGroup'),
      onItemClick: insert({
        type: 'columnList',
        children: [
          { type: 'column', children: [{ type: 'paragraph' }] },
          { type: 'column', children: [{ type: 'paragraph' }] },
        ],
      }),
    },
    {
      title: t('slash.embed'),
      subtext: t('slash.embedHint'),
      aliases: ['link card', 'link', 'card', 'bookmark', 'document', 'unfurl', 'embed document'],
      group: t('slash.blocksGroup'),
      onItemClick: insert({ type: 'embed' }),
    },
    {
      title: t('slash.dataTable'),
      subtext: t('slash.dataTableHint'),
      aliases: ['table', 'data', 'records', 'database', 'sheet'],
      group: t('slash.group'),
      onItemClick: insert({ type: 'dataTable' }),
    },
  ];
}

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length]!;
}
