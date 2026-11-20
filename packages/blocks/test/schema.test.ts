import { describe, expect, it } from 'vitest';
import { defaultBlockSpecs } from '@blocknote/core';
import { primerSchema } from '../src/index.ts';

describe('primerSchema', () => {
  it('schema has stock blocks plus source', () => {
    const types = Object.keys(primerSchema.blockSpecs);
    for (const stock of Object.keys(defaultBlockSpecs)) expect(types).toContain(stock);
    expect(types).toEqual(expect.arrayContaining(['codeBlock', 'mathBlock', 'diagram', 'source']));
    expect(primerSchema.blockSpecs.source.config.propSchema).toEqual({
      markdown: { default: '' },
      previewHtml: { default: '' },
    });
    expect(primerSchema.blockSpecs.source.config.content).toBe('none');
  });
});
