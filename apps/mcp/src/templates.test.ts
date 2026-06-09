/**
 * Registry tests for @primer/shared/templates.
 *
 * The registry lives in @primer/shared, which has no test runner of its own
 * (adding one would touch the lockfile). The MCP package already imports it and
 * runs vitest, so we exercise the registry here.
 */
import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  getTemplate,
  isValidTemplateId,
  listTemplates,
  resolveDocumentTemplate,
} from '@primer/shared/templates';

describe('template registry', () => {
  it('ships the paperclip-punkify template with required metadata', () => {
    const t = TEMPLATES['paperclip-punkify'];
    expect(t).toBeDefined();
    expect(t.id).toBe('paperclip-punkify');
    expect(t.label).toBe('Paperclip Punk');
    expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(t.instructions.length).toBeGreaterThan(100);
  });

  it('listTemplates returns lightweight summaries without instructions', () => {
    const summaries = listTemplates();
    expect(summaries.length).toBeGreaterThan(0);
    const paperclip = summaries.find((s) => s.id === 'paperclip-punkify');
    expect(paperclip).toEqual({
      id: 'paperclip-punkify',
      label: 'Paperclip Punk',
      description: expect.any(String),
    });
    // Summaries must not carry the heavy instructions blob.
    expect(paperclip).not.toHaveProperty('instructions');
  });

  it('getTemplate returns the full record (with instructions) or undefined', () => {
    expect(getTemplate('paperclip-punkify')?.instructions).toContain('paperclip punk');
    expect(getTemplate('does-not-exist')).toBeUndefined();
  });

  it('isValidTemplateId distinguishes known from unknown ids', () => {
    expect(isValidTemplateId('paperclip-punkify')).toBe(true);
    expect(isValidTemplateId('nope')).toBe(false);
    expect(isValidTemplateId('')).toBe(false);
  });

  describe('resolveDocumentTemplate', () => {
    it('resolves a known id to its display DTO', () => {
      expect(resolveDocumentTemplate('paperclip-punkify')).toEqual({
        id: 'paperclip-punkify',
        label: 'Paperclip Punk',
        color: '#670DE5',
      });
    });

    it('returns null for null (untemplated version)', () => {
      expect(resolveDocumentTemplate(null)).toBeNull();
    });

    it('returns null for an unknown id (degrade gracefully to no badge)', () => {
      expect(resolveDocumentTemplate('removed-template')).toBeNull();
    });
  });
});
