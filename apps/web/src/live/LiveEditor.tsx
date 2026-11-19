import { useEffect, useState } from 'react';
import { BlockNoteViewEditor, useCreateBlockNote } from '@blocknote/react';
import { VersioningSidebar } from '@blocknote/react/versioning';
import { BlockNoteView } from '@blocknote/ariakit';
import { withCollaboration, YjsVersioningExtension } from '@blocknote/core/yjs';
import * as locales from '@blocknote/core/locales';
import { commentMarkExtension, primerSchema } from '@primer/blocks';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/ariakit/style.css';
import type { DocFileUploadResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { ConnectionStatus } from './ConnectionStatus.tsx';
import { createLiveProvider, type LiveProvider } from './provider.ts';
import { PrimerVersionStorage } from './versionStorage.ts';

export type LiveEditorProps = {
  documentId: string;
  readOnly: boolean;
  theme: 'light' | 'dark';
  /** Shown on this viewer's cursor to everyone else. */
  userName: string;
};

/**
 * A live document in BlockNote, synced over `/collab`: stock blocks, the
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

function LiveEditorView({ live, documentId, readOnly, theme, userName }: LiveEditorProps & { live: LiveProvider }) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const editor = useCreateBlockNote(
    withCollaboration({
      schema: primerSchema,
      // Until comments ship, the comment mark must still be known, or
      // y-prosemirror would delete commented text.
      extensions: [commentMarkExtension, YjsVersioningExtension({ storage: new PrimerVersionStorage(documentId) })],
      collaboration: {
        provider: { awareness: live.provider.awareness ?? undefined },
        fragment: live.doc.getXmlFragment('document-store'),
        user: { name: userName, color: colorFor(userName) },
      },
      dictionary: dictionaryFor(typeof navigator === 'undefined' ? 'en' : navigator.language),
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
    [live],
  );

  return (
    <div className="flex h-full flex-col" data-live-editor={documentId}>
      <ConnectionStatus provider={live.provider} />
      <div className="flex items-center justify-end gap-2 px-4 pt-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-pressed={historyOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          History
        </button>
      </div>
      <BlockNoteView editor={editor} editable={!readOnly} theme={theme} renderEditor={false} className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto py-4">
          <BlockNoteViewEditor />
        </div>
        {historyOpen && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 dark:border-neutral-800">
            <VersioningSidebar onClose={() => setHistoryOpen(false)} />
          </div>
        )}
      </BlockNoteView>
    </div>
  );
}

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length]!;
}

function dictionaryFor(language: string) {
  const all = locales as unknown as Record<string, typeof locales.en>;
  return all[language.toLowerCase().split('-')[0] ?? 'en'] ?? locales.en;
}
