import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import de from './de.json';
import es from './es.json';
import fr from './fr.json';
import ja from './ja.json';
import zh from './zh.json';
import { resolveLocale } from './index.ts';

const SRC = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Attributes whose string value a person reads. */
const READ_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'aria-description']);
/** Object properties that carry text to show (feedback messages, menu labels). */
const READ_PROPERTIES = new Set(['message', 'label', 'title', 'text', 'description', 'placeholder', 'error', 'heading']);
/** Words that are text to a person. Header names, enums and ids never start like this. */
const PROSE = /^[A-Z][a-z]+[a-z'’ .,!?:;…—–()\d-]*$/;

describe('i18n', () => {
  it('every locale file has every key in en.json', () => {
    const keys = Object.keys(en).sort();
    for (const [name, messages] of Object.entries({ de, es, fr, ja, zh })) {
      expect(Object.keys(messages).sort(), name).toEqual(keys);
    }
  });

  it('keeps every placeholder in every translation', () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [name, messages] of Object.entries({ de, es, fr, ja, zh })) {
      for (const [key, text] of Object.entries(messages)) expect(placeholders(text), `${name} ${key}`).toEqual(placeholders((en as Record<string, string>)[key]!));
    }
  });

  it('the browser language picks the locale, with en as the fallback', () => {
    expect(resolveLocale('de-AT')).toBe('de');
    expect(resolveLocale('ja')).toBe('ja');
    expect(resolveLocale('pt-BR')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('no JSX text literal remains outside i18n', () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const flag = (node: ts.Node, text: string) =>
        found.push(`${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}  ${JSON.stringify(text.trim().slice(0, 50))}`);
      const inJsxExpression = (node: ts.Node) => {
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isJsxExpression(p)) return !(p.parent && ts.isJsxAttribute(p.parent) && !READ_ATTRIBUTES.has(p.parent.name.getText()));
          if (ts.isJsxAttribute(p)) return false;
          if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) return false;
        }
        return false;
      };
      (function visit(node: ts.Node) {
        if (ts.isJsxText(node) && /[\p{L}]/u.test(node.text)) flag(node, node.text);
        else if (ts.isStringLiteralLike(node) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
          const text = node.text;
          const parent = node.parent;
          const attribute = ts.isJsxAttribute(parent) && READ_ATTRIBUTES.has(parent.name.getText());
          const property = ts.isPropertyAssignment(parent) && READ_PROPERTIES.has(parent.name.getText().replace(/['"]/g, ''));
          const shown = ts.isJsxAttribute(parent) ? attribute : inJsxExpression(node) || property;
          if (shown && /[\p{L}]/u.test(text) && (PROSE.test(text) || /\p{Script=Han}|\p{Script=Hiragana}/u.test(text)) && !/^[a-z]+$/.test(text)) flag(node, text);
          else if (!shown && text.includes(' ') && PROSE.test(text) && text.length > 12 && !ts.isJsxAttribute(parent) && !ts.isCallExpression(parent)) flag(node, text);
        } else if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const head = ts.isTemplateExpression(node) ? node.head.text : node.text;
          if (/^[A-Z][a-z]+ [a-z]/.test(head) && !ts.isTaggedTemplateExpression(node.parent)) flag(node, head);
        }
        ts.forEachChild(node, visit);
      })(sf);
    }
    expect(found).toEqual([]);
  });
});
