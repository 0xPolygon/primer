import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type {
  Refusal,
  WidgetDTO,
  WidgetDraftRequest,
  WidgetDraftResponse,
  WidgetError,
  WidgetLabelOutcome,
  WidgetPublishResponse,
  WidgetRowInput,
} from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, widgets } from '../db/schema.ts';
import { canEdit, canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { serverEditor } from '../live/editor.ts';
import { originFor } from '../live/origin.ts';
import { applyPlan, type PlannedEdit } from '../live/pipeline.ts';
import { MAIN_TAB } from '../live/reach.ts';
import { carryLabels, labelEdit, readLabel, readLiveDoc, tabOfBlock } from './labels.ts';
import { rasterise } from './raster.ts';
import { renderBoth, widgetIdPrefix, type WidgetRow, type WidgetTheme } from './render.ts';
import { labelsOf, withLabels } from './serialize.ts';

export type WidgetResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409 | 422; refusal: Refusal };

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_ROWS_BYTES = 1024 * 1024;

const NOT_FOUND: Refusal = { code: 'not_found', message: 'No such widget or document.', fix: 'Check the id; you may not have access.' };

type WidgetRowRecord = typeof widgets.$inferSelect;

function invalid(message: string, errors: WidgetError[]): WidgetResult<never> {
  return {
    ok: false,
    status: 422,
    refusal: {
      code: 'widget_invalid',
      message,
      fix: 'Fix each error (its line and fix are in details.errors) and draft again; the live widget is unchanged.',
      details: { errors },
    },
  };
}

async function documentAccess(
  documentId: string,
  actor: AuthUser,
  need: 'read' | 'edit',
): Promise<{ ok: true } | { ok: false; status: 400 | 403 | 404; refusal: Refusal }> {
  const [doc] = await db
    .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, format: documents.format, deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc || doc.deletedAt) return { ok: false, status: 404, refusal: NOT_FOUND };
  const visibility = doc.visibility as Visibility;
  const role = await loadEffectiveRole({ id: documentId, uploaderId: doc.uploaderId, visibility }, actor);
  if (!canRead(visibility, role)) return { ok: false, status: 404, refusal: NOT_FOUND };
  if (need === 'edit' && !canEdit(role)) {
    return { ok: false, status: 403, refusal: { code: 'forbidden', message: 'Only the owner and editors change widgets.', fix: 'Ask the owner for editor access.' } };
  }
  if (doc.format === null) {
    return {
      ok: false,
      status: 400,
      refusal: { code: 'bad_request', message: 'Widgets live in live documents; this one is a legacy HTML document.', fix: 'Draw the widget in a Markdown or text document.' },
    };
  }
  return { ok: true };
}

async function loadWidget(widgetId: string): Promise<WidgetRowRecord | null> {
  if (!/^[0-9a-f-]{36}$/.test(widgetId)) return null;
  const [row] = await db.select().from(widgets).where(eq(widgets.id, widgetId));
  return row ?? null;
}

/** The words people see on each published label now: the fragment's, else the publish's. */
async function currentLabels(row: WidgetRowRecord): Promise<Record<string, string>> {
  const published = row.publishedSvgLight ? labelsOf(row.publishedSvgLight) : {};
  const mine = await fragmentLabels(row, Object.keys(published));
  return Object.fromEntries(Object.entries(published).map(([id, text]) => [id, mine[id] ?? text]));
}

/** Each label's words once `theirs` (a new render's labels) is published. */
async function carryFor(row: Pick<WidgetRowRecord, 'documentId' | 'blockId' | 'publishedSvgLight'>, theirs: Record<string, string>) {
  const base = row.publishedSvgLight ? labelsOf(row.publishedSvgLight) : {};
  return carryLabels(base, await fragmentLabels(row, Object.keys(theirs)), theirs);
}

async function fragmentLabels(row: Pick<WidgetRowRecord, 'documentId' | 'blockId'>, textIds: string[]): Promise<Record<string, string | null>> {
  if (textIds.length === 0) return {};
  return readLiveDoc(row.documentId, (doc) =>
    Object.fromEntries(textIds.map((textId) => [textId, readLabel(doc, row.blockId, textId)])),
  );
}

function checkInput(source: unknown, rows: unknown): WidgetError[] {
  if (typeof source !== 'string' || source.trim() === '') return [{ line: 0, message: 'source is required.', fix: 'Send the whole module as `source`.' }];
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return [{ line: 0, message: 'source is over 1 MB.', fix: 'Draw from rows instead of typing data into the module.' }];
  if (rows !== undefined && JSON.stringify(rows).length > MAX_ROWS_BYTES) return [{ line: 0, message: 'rows are over 1 MB.', fix: 'Aggregate the rows first.' }];
  return [];
}

/**
 * Renders a draft for both themes and stores it beside the live publish. A new
 * widget's block is placed now (it shows nothing until the first publish); a
 * draft with errors creates nothing and changes no live widget. The previews
 * show the draft as people will see it once published, label edits carried.
 */
export async function draftWidget(actor: AuthUser, documentId: string, req: WidgetDraftRequest): Promise<WidgetResult<WidgetDraftResponse>> {
  const access = await documentAccess(documentId, actor, 'edit');
  if (!access.ok) return access;
  let existing: WidgetRowRecord | null = null;
  if (req.widgetId !== undefined) {
    existing = await loadWidget(req.widgetId);
    if (!existing || existing.documentId !== documentId) return { ok: false, status: 404, refusal: NOT_FOUND };
  }
  const inputErrors = checkInput(req.source, req.rows);
  if (inputErrors.length > 0) return invalid('The draft request is invalid.', inputErrors);

  const widgetId = existing?.id ?? uuidv7();
  const rows = (req.rows ?? []) as WidgetRow[];
  const rendered = await renderBoth(req.source, rows, widgetIdPrefix(widgetId));
  if ('errors' in rendered) {
    if (existing) {
      await db
        .update(widgets)
        .set({ draftSource: req.source, draftRows: req.rows ?? null, draftErrors: rendered.errors, updatedBy: actor.id, updatedAt: new Date() })
        .where(eq(widgets.id, widgetId));
    }
    return invalid(`The draft has ${rendered.errors.length} error${rendered.errors.length === 1 ? '' : 's'}; the live widget is unchanged.`, rendered.errors);
  }

  let blockId: string;
  if (existing) {
    blockId = existing.blockId;
    await db
      .update(widgets)
      .set({ draftSource: req.source, draftRows: req.rows ?? null, draftErrors: null, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(widgets.id, widgetId));
  } else {
    const placed = await placeBlock(actor, documentId, widgetId, req);
    if (!placed.ok) return placed;
    blockId = placed.value;
    await db.insert(widgets).values({
      id: widgetId,
      documentId,
      blockId,
      draftSource: req.source,
      draftRows: req.rows ?? null,
      updatedBy: actor.id,
    });
  }

  const carried = await carryFor({ documentId, blockId, publishedSvgLight: existing?.publishedSvgLight ?? null }, rendered.light.labels);
  const [light, dark] = await Promise.all([
    rasterise(withLabels(rendered.light.svg, carried.texts), 'light'),
    rasterise(withLabels(rendered.dark.svg, carried.texts), 'dark'),
  ]);
  return {
    ok: true,
    value: {
      widgetId,
      blockId,
      previewHash: rendered.hash,
      png: { light: light.toString('base64'), dark: dark.toString('base64') },
      warnings: rendered.light.warnings,
      labels: carried.outcomes,
    },
  };
}

/** Places a new, empty widget block after `afterBlockId` (or at the end of the tab). */
async function placeBlock(actor: AuthUser, documentId: string, widgetId: string, req: WidgetDraftRequest): Promise<WidgetResult<string>> {
  const tabId = req.tabId ?? MAIN_TAB;
  if (req.afterBlockId !== undefined) {
    const tab = await readLiveDoc(documentId, (doc) => tabOfBlock(doc, req.afterBlockId!));
    if (tab !== tabId) {
      return {
        ok: false,
        status: 409,
        refusal: { code: 'target_changed', message: `Block ${req.afterBlockId} is not in tab ${tabId}.`, fix: 'Read the document again and pass a current block id.' },
      };
    }
  }
  const blockId = uuidv7();
  const container = serverEditor()._blocksToProsemirrorNode([
    { id: blockId, type: 'widget', props: { widgetId, hash: '', textIds: '' } },
  ] as never).firstChild!.firstChild!;
  await applyPlan(documentId, originFor(actor), {
    onConflict: 'refuse',
    edits: [
      {
        target: { tabId, blockId: req.afterBlockId ?? '' },
        inverse: false,
        build: (tr, at) => {
          tr.insert(at ? at.pos + at.node.nodeSize : tr.doc.content.size - 1, container);
        },
      },
    ],
  });
  return { ok: true, value: blockId };
}

/**
 * Publishes the current draft, only if it still renders exactly the preview
 * the agent saw (`previewHash`). In one pipeline plan, each label fragment
 * gets its words (people's edits carried, see `carryLabels`) and the block
 * gets the new hash and text ids, so viewers redraw.
 */
export async function publishWidget(actor: AuthUser, widgetId: string, previewHash: string): Promise<WidgetResult<WidgetPublishResponse>> {
  const row = await loadWidget(widgetId);
  if (!row) return { ok: false, status: 404, refusal: NOT_FOUND };
  const access = await documentAccess(row.documentId, actor, 'edit');
  if (!access.ok) return access;
  if (row.draftSource === null || row.draftErrors !== null) {
    return invalid('There is no valid draft to publish.', (row.draftErrors as WidgetError[] | null) ?? []);
  }
  const rendered = await renderBoth(row.draftSource, (row.draftRows ?? []) as WidgetRow[], widgetIdPrefix(widgetId));
  if ('errors' in rendered) return invalid('The draft no longer renders.', rendered.errors);
  if (rendered.hash !== previewHash) {
    return {
      ok: false,
      status: 409,
      refusal: {
        code: 'widget_invalid',
        message: 'The current draft is not the preview you saw.',
        fix: 'Draft again, look at the new preview, and publish its previewHash.',
        details: { previewHash: rendered.hash },
      },
    };
  }

  const updated = await db
    .update(widgets)
    .set({
      publishedSource: row.draftSource,
      publishedSvgLight: rendered.light.svg,
      publishedSvgDark: rendered.dark.svg,
      publishedHash: rendered.hash,
      rows: row.draftRows,
      draftSource: null,
      draftRows: null,
      draftErrors: null,
      updatedBy: actor.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(widgets.id, widgetId),
        eq(widgets.draftSource, row.draftSource),
        sql`${widgets.draftRows} IS NOT DISTINCT FROM ${row.draftRows === null ? null : JSON.stringify(row.draftRows)}::jsonb`,
        sql`${widgets.publishedHash} IS NOT DISTINCT FROM ${row.publishedHash}`,
      ),
    )
    .returning({ id: widgets.id });
  if (updated.length === 0) {
    return {
      ok: false,
      status: 409,
      refusal: { code: 'widget_invalid', message: 'The widget changed while publishing.', fix: 'Read the widget, draft again and publish the new preview.' },
    };
  }

  const theirs = rendered.light.labels;
  const carried = await carryFor(row, theirs);
  const tabId = (await readLiveDoc(row.documentId, (doc) => tabOfBlock(doc, row.blockId))) ?? MAIN_TAB;
  const edits: PlannedEdit[] = Object.entries(carried.texts).map(([textId, text]) =>
    labelEdit({ tabId, blockId: row.blockId, textId }, text),
  );
  edits.push({
    target: { tabId, blockId: row.blockId },
    inverse: false,
    build: (tr, at) => {
      if (!at) return; // a person deleted the block: the widget stays unplaced
      const content = at.node.firstChild!;
      tr.setNodeMarkup(at.pos + 1, undefined, { ...content.attrs, hash: rendered.hash, textIds: Object.keys(theirs).join(' ') });
    },
  });
  const result = await applyPlan(row.documentId, originFor(actor), { onConflict: 'refuse', edits });
  return {
    ok: true,
    value: { widgetId, blockId: row.blockId, publishedHash: rendered.hash, docVersion: result.docVersion, labels: carried.outcomes },
  };
}

export async function getWidget(actor: AuthUser, widgetId: string): Promise<WidgetResult<WidgetDTO>> {
  const row = await loadWidget(widgetId);
  if (!row) return { ok: false, status: 404, refusal: NOT_FOUND };
  const access = await documentAccess(row.documentId, actor, 'read');
  if (!access.ok) return access;
  const labels = await currentLabels(row);
  return {
    ok: true,
    value: {
      id: row.id,
      documentId: row.documentId,
      blockId: row.blockId,
      source: row.publishedSource,
      rows: row.rows as WidgetRowInput[] | null,
      publishedHash: row.publishedHash,
      labels,
      draft:
        row.draftSource === null
          ? null
          : { source: row.draftSource, rows: row.draftRows as WidgetRowInput[] | null, errors: row.draftErrors as WidgetError[] | null },
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

/** The live widget as people see it (people's label edits applied), as SVG or PNG. */
export async function widgetImage(
  actor: AuthUser,
  widgetId: string,
  theme: WidgetTheme,
  format: 'svg' | 'png',
): Promise<WidgetResult<{ svg: string } | { png: Buffer }>> {
  const dto = await getWidget(actor, widgetId);
  if (!dto.ok) return dto;
  const row = (await loadWidget(widgetId))!;
  const published = theme === 'light' ? row.publishedSvgLight : row.publishedSvgDark;
  if (!published) {
    return { ok: false, status: 404, refusal: { code: 'not_found', message: 'The widget has not been published yet.', fix: 'Publish a draft first.' } };
  }
  const svg = withLabels(published, dto.value.labels);
  return { ok: true, value: format === 'svg' ? { svg } : { png: await rasterise(svg, theme) } };
}

export type { WidgetLabelOutcome };
