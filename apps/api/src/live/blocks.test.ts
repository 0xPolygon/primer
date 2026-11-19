import { describe, expect, it } from 'vitest';
import { Transform } from '@tiptap/pm/transform';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';

describe('blockVersion', () => {
  it("editing a child changes the parent's version", () => {
    const editor = serverEditor();
    const build = (childText: string) =>
      editor._blocksToProsemirrorNode([
        {
          id: 'parent',
          type: 'bulletListItem',
          content: 'Parent',
          children: [{ id: 'child', type: 'bulletListItem', content: childText }],
        },
      ]);
    const before = build('Child');
    const after = build('Child, edited');
    const version = (doc: typeof before, id: string) => blockVersion(findBlock(doc, id)!.node);

    expect(version(before, 'parent')).toMatch(/^[0-9a-f]{16}$/);
    expect(version(after, 'parent')).not.toBe(version(before, 'parent'));
    expect(version(after, 'child')).not.toBe(version(before, 'child'));

    // A comment on the child annotates it; it doesn't change any version.
    const child = findBlock(before, 'child')!;
    const tr = new Transform(before).addMark(
      child.pos + 2,
      child.pos + 2 + 'Child'.length,
      editor.editor.pmSchema.marks.comment!.create({ threadId: 't1' }),
    );
    expect(tr.docChanged).toBe(true);
    expect(version(tr.doc, 'child')).toBe(version(before, 'child'));
    expect(version(tr.doc, 'parent')).toBe(version(before, 'parent'));
  });
});
