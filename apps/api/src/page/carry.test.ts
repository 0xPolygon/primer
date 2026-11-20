import { describe, expect, it } from 'vitest';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { serverEditor } from '../live/editor.ts';
import { createLiveDoc, withLiveDoc } from '../live/live.testlib.ts';
import { SYSTEM_ORIGIN } from '../live/origin.ts';
import { applyPlan } from '../live/pipeline.ts';
import { fragmentFor } from '../live/reach.ts';
import { carryText, planCarry, type CarryDecision } from './carry.ts';
import { splicePage } from './splice.ts';
import { stampPage } from './stamp.ts';
import { pidTarget, readPidText, setPidText } from './text.ts';

const target = (pid: string) => pidTarget('main', 'page1', pid);

async function seed(documentId: string, pids: { pid: string; text: string }[]) {
  await applyPlan(documentId, SYSTEM_ORIGIN, {
    onConflict: 'refuse',
    edits: pids.map((p) => setPidText(target(p.pid), p.text)),
  });
}

async function texts(documentId: string, pids: string[]) {
  return withLiveDoc(documentId, (doc) => new Map(pids.map((pid) => [pid, readPidText(doc, target(pid))])));
}

describe('page text', () => {
  it('round-trips through a real fragment and splices nothing when untouched', async () => {
    const page = '<body><p>\n   Indented   text,\n   two lines\n</p><p>a&nbsp;&amp;&nbsp;b  &lt;c&gt;</p><p>x<br>y</p><pre>keep\n  this</pre></body>';
    const { stamped, pids } = stampPage(page);
    const id = await createLiveDoc();
    await seed(id, pids);
    const current = await texts(id, pids.map((p) => p.pid));
    expect([...current.values()]).toEqual(pids.map((p) => p.text));
    expect(splicePage(stamped, current)).toBe(stamped);
  });

  it('an edit keeps the comment mark on the rest of the text', async () => {
    const id = await createLiveDoc();
    await seed(id, [{ pid: 'p1', text: 'Hello brave world' }]);
    const comment = serverEditor().editor.pmSchema.marks.comment!.create({ threadId: 't1' });
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [{ target: target('p1'), inverse: false, build: (tr) => void tr.addMark(3, 8, comment) }],
    });
    await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [setPidText(target('p1'), 'Hello brave new world!')] });
    await withLiveDoc(id, (doc) => {
      expect(readPidText(doc, target('p1'))).toBe('Hello brave new world!');
      const json = JSON.stringify(yXmlFragmentToProsemirrorJSON(fragmentFor(doc, target('p1'))));
      expect(json).toContain('{"type":"text","text":"Hello","marks":[{"type":"comment","attrs":{"orphan":false,"threadId":"t1"}}]}');
    });
  });
});

describe('carry-over', () => {
  it('three-way carry-over table', async () => {
    // base → (mine, theirs): one case per row of carry.ts.
    expect(carryText(undefined, undefined, 'T', false)).toEqual({ text: 'T', suggest: null, carried: false });
    expect(carryText('B', 'B', 'T', false)).toEqual({ text: 'T', suggest: null, carried: false });
    expect(carryText('B', 'M', 'B', false)).toEqual({ text: 'M', suggest: null, carried: true });
    expect(carryText('B', 'M', 'M', false)).toEqual({ text: 'M', suggest: null, carried: false });
    expect(carryText('B', 'M', 'T', false)).toEqual({ text: 'T', suggest: 'M', carried: false });
    expect(carryText('B', 'M', 'B', true)).toEqual({ text: 'B', suggest: 'M', carried: false });

    // Through the pipeline: an agent republish that keeps one heading, rewrites
    // a paragraph people also edited, and removes a third element.
    const v1 = stampPage('<body><h1>Plan</h1><p>Ship in May.</p><p>Draft note.</p><p>Remove me.</p></body>');
    const id = await createLiveDoc();
    await seed(id, v1.pids);
    await seed(id, [
      { pid: 'p1', text: 'Plan for 2027' },
      { pid: 'p2', text: 'Ship in June.' },
    ]);
    const v2 = stampPage('<body><h1>Plan</h1><p>Ship in early May.</p><p>Draft note, final.</p></body>', v1.pids);
    expect(v2.pids.map((p) => p.pid)).toEqual(['p1', 'p2', 'p3']);

    const decisions: CarryDecision[] = [];
    const result = await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: planCarry({ tabId: 'main', blockId: 'page1', previous: v1.pids, next: v2.pids, uncertain: v2.uncertain, decisions }),
    });
    expect(result.outcomes.map((o) => o.status)).toEqual(['unchanged', 'applied', 'applied']);
    expect(decisions.map(({ pid, text, suggest, carried }) => ({ pid, text, suggest, carried }))).toEqual([
      { pid: 'p1', text: 'Plan for 2027', suggest: null, carried: true },
      { pid: 'p2', text: 'Ship in early May.', suggest: 'Ship in June.', carried: false },
      { pid: 'p3', text: 'Draft note, final.', suggest: null, carried: false },
    ]);
    const current = await texts(id, ['p1', 'p2', 'p3']);
    expect(splicePage(v2.stamped, current)).toBe(
      '<body><h1 data-pid="p1">Plan for 2027</h1><p data-pid="p2">Ship in early May.</p><p data-pid="p3">Draft note, final.</p></body>',
    );
  });

  it('repeated labels are never carried silently', async () => {
    const page = '<body><a>Learn more</a><a>Learn more</a><a>Learn more</a></body>';
    const v1 = stampPage(page);
    const id = await createLiveDoc();
    await seed(id, v1.pids);
    await seed(id, [{ pid: 'p2', text: 'Read the report' }]);
    // The agent republishes without keeping the pids.
    const v2 = stampPage(page, v1.pids);
    expect(v2.uncertain).toEqual(['p1', 'p2', 'p3']);

    const decisions: CarryDecision[] = [];
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: planCarry({ tabId: 'main', blockId: 'page1', previous: v1.pids, next: v2.pids, uncertain: v2.uncertain, decisions }),
    });
    expect(decisions.find((d) => d.pid === 'p2')).toMatchObject({ text: 'Learn more', suggest: 'Read the report', carried: false });
    expect(decisions.filter((d) => d.suggest !== null)).toHaveLength(1);
  });
});
