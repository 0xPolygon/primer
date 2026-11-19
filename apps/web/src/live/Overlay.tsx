import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';
import { BlockNoteViewEditor, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/ariakit';
import { withCollaboration } from '@blocknote/core/yjs';
import { CommentsExtension } from '@blocknote/core/comments';
import type { Target } from '@polygonlabs/primer-api-types';
import { primerSchema } from '@primer/blocks';
import { editorDictionary, t } from '../i18n/index.ts';
import { PrimerThreadStore, type StoreViewer } from './PrimerThreadStore.ts';
import { useThreadEvents } from './threadEvents.ts';
import './blocks.css';

/** A rect in the host window's viewport (CSS pixels). */
export type OverlayRect = { x: number; y: number; width: number; height: number };

/** The Y.XmlFragment a sub-fragment target names (C3; apps/api/src/live/reach.ts). */
export function subFragmentName(target: Target): string {
  if (target.pid) return `page/${target.blockId}/${target.pid}`;
  if (target.embedId) return `embed/${target.blockId}/${target.embedId}`;
  if (target.textId) return `widget/${target.blockId}/${target.textId}`;
  throw new Error('the overlay edits sub-fragments only (pid, embedId or textId)');
}

export type OverlayProps = {
  /** The document's Y.Doc, from the live provider the editor uses. */
  doc: Y.Doc;
  documentId: string;
  /** A target with a sub-fragment: page text (`pid`), a page's Primer block
   *  (`embedId`) or a widget label (`textId`). */
  target: Target;
  /** Where the edited element is, in the host viewport. */
  rect: OverlayRect;
  /** `text`: one paragraph of plain text (page text, widget labels), with
   *  comments; `blocks`: a full block editor (embeds). */
  kind: 'text' | 'blocks';
  /** Commenters and readers see the text but can't change it. */
  readOnly: boolean;
  theme: 'light' | 'dark';
  viewer: StoreViewer & { name: string };
  onClose: () => void;
};

/**
 * The one host overlay (C9): a BlockNote editor in Primer's own window, drawn
 * over an element of a sandboxed page (or a widget), bound to that element's
 * sub-fragment of the document. Keystrokes never reach the page's scripts;
 * the page only ever receives the resulting text. Page text keeps BlockNote's
 * comments, anchored by comment marks in its fragment like any prose.
 *
 * Closes on Escape and on a click outside it.
 */
export function Overlay(props: OverlayProps) {
  const { doc, documentId, target, kind, readOnly, theme, viewer, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  const threadStore = useMemo(
    () => (kind === 'text' && target.pid ? new PrimerThreadStore(documentId, target.tabId, viewer, undefined, { blockId: target.blockId, pid: target.pid }) : null),
    [documentId, kind, target.tabId, target.blockId, target.pid, viewer],
  );
  useThreadEvents(documentId, () => void threadStore?.refresh());

  const editor = useCreateBlockNote(
    withCollaboration({
      schema: primerSchema,
      extensions: threadStore
        ? [
            CommentsExtension({
              threadStore,
              resolveUsers: async (ids: string[]) => ids.map((id) => ({ id, username: threadStore.names.get(id) ?? id, avatarUrl: '' })),
            }),
          ]
        : [],
      // No awareness: the document's own editor already shows this viewer's
      // cursor, and two editors on one awareness would fight over it.
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(subFragmentName(target)),
        user: { name: viewer.name, color: '#2563eb' },
      },
      dictionary: editorDictionary(),
    }),
    [doc, subFragmentName(target), threadStore],
  );
  useEffect(() => {
    if (threadStore) {
      threadStore.editor = editor;
      void threadStore.refresh();
    }
    if (readOnly) return;
    // Open with the cursor at the end of the text, ready to type.
    setTimeout(() => {
      const last = editor.document[editor.document.length - 1];
      if (last) editor.setTextCursorPosition(last, 'end');
      editor.focus();
    }, 0);
  }, [editor, threadStore, readOnly]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      // BlockNote's menus and comment popovers render in portals of their own.
      if (box.current?.contains(el) || el?.closest('.bn-ui-container, [data-floating-ui-portal], .bn-comments')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  const width = Math.max(props.rect.width, kind === 'text' ? 240 : 420);
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={t(kind === 'text' ? 'overlay.editText' : 'overlay.editBlock')}
      data-primer-overlay={subFragmentName(target)}
      className="fixed z-50 rounded border border-sky-400 bg-white shadow-lg dark:bg-neutral-900"
      style={{ left: props.rect.x - 4, top: props.rect.y - 4, width: width + 8, minHeight: props.rect.height + 8 }}
    >
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme={theme}
        sideMenu={kind === 'blocks'}
        slashMenu={kind === 'blocks'}
        renderEditor={false}
        className="primer-overlay"
      >
        <BlockNoteViewEditor />
      </BlockNoteView>
    </div>,
    document.body,
  );
}
