import { SVG_TAGS } from '../upload/sanitize.ts';
import { parseWidget, WidgetSyntaxError, type AstNode, type ParsedWidget, type WidgetError } from './parse.ts';

/** Names a widget may not touch: the sandbox has none of them, so using one
 *  is a mistake to report at the source rather than a runtime error. */
const BANNED_NAMES = new Set(['require', 'fetch', 'eval', 'Function', 'globalThis', 'XMLHttpRequest', 'WebSocket']);
const ALLOWED_TAGS = new Set(SVG_TAGS);
const COLOUR_ATTRS = new Set(['fill', 'stroke', 'color', 'stop-color', 'stopColor']);
/** Text that is not drawn: `<title>` is a hover tip, `<desc>` a description. */
const UNDRAWN_TEXT_TAGS = new Set(['title', 'desc']);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type InspectedWidget = {
  errors: WidgetError[];
  parsed: ParsedWidget | null;
  /** Each literal `data-text-id` and the words typed under it. */
  labels: Map<string, string>;
};

/**
 * Checks a widget module before it runs. These checks give an agent a line and
 * a fix; they are not the safety boundary (the sandbox and the runtime output
 * check in serialize.ts are), because a spread or a direct `__h` call can hide
 * anything from a reading of the source.
 */
export function validateWidget(source: string): { ok: true } | { ok: false; errors: WidgetError[] } {
  const { errors } = inspectWidget(source);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function inspectWidget(source: string): InspectedWidget {
  let parsed: ParsedWidget;
  try {
    parsed = parseWidget(source);
  } catch (e) {
    if (e instanceof WidgetSyntaxError) return { errors: [e.error], parsed: null, labels: new Map() };
    throw e;
  }
  const errors: WidgetError[] = [];
  const labels = new Map<string, string>();
  const report = (node: AstNode, message: string, fix: string) =>
    errors.push({ line: node.loc?.start.line ?? 1, message, fix });

  const exports = (parsed.ast.body as AstNode[]).filter((s) => s.type === 'ExportDefaultDeclaration');
  const render = exports[0]?.declaration;
  if (
    exports.length !== 1 ||
    !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(render?.type)
  ) {
    report(
      exports[1] ?? parsed.ast,
      'A widget module has exactly one `export default` function.',
      'Write `export default function render({ rows, tokens }) { return <svg>…</svg>; }`, or a bare `<svg>…</svg>`.',
    );
  }

  walk(parsed.ast, null, (node, parent) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ImportExpression':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        report(node, 'Widgets have no imports or other exports.', 'Inline what you need; everything comes from `rows` and `tokens`.');
        return;
      case 'MetaProperty':
        report(node, '`import.meta` is not available in a widget.', 'Remove it.');
        return;
      case 'Identifier':
      case 'JSXIdentifier':
        if (BANNED_NAMES.has(node.name) && !isPropertyName(node, parent)) {
          report(node, `\`${node.name}\` is not available in a widget.`, 'Widgets only draw: compute from `rows` and `tokens`, with no network, eval or globals.');
        }
        return;
      case 'MemberExpression':
        if (isClockOrRandom(node)) {
          report(node, 'A widget draws the same every time: no clock and no random numbers.', 'Take dates and values from `rows`.');
        }
        return;
      case 'NewExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) {
          report(node, 'A widget draws the same every time: `new Date()` reads the clock.', 'Take dates from `rows`, e.g. `new Date(row.date)`.');
        }
        return;
      case 'JSXElement':
        checkElement(node, labels, report);
        return;
    }
  });

  errors.sort((a, b) => a.line - b.line);
  return { errors, parsed, labels };
}

type Report = (node: AstNode, message: string, fix: string) => void;

function checkElement(node: AstNode, labels: Map<string, string>, report: Report): void {
  const name = node.openingElement.name;
  const tag = name.type === 'JSXIdentifier' ? name.name : null;
  const intrinsic = tag !== null && /^[a-z]/.test(tag);
  if (tag === 'style' || tag === 'foreignObject') {
    report(node, `<${tag}> is not an element widgets may render.`, 'Use presentation attributes (fill, stroke, font-size) on each element; break lines with <tspan>.');
    return;
  }
  if (intrinsic && !ALLOWED_TAGS.has(tag)) {
    report(node, `<${tag}> is not an element widgets may render.`, `Use SVG elements only: ${[...ALLOWED_TAGS].join(', ')}.`);
  }

  let textId: string | null = null;
  for (const attr of node.openingElement.attributes as AstNode[]) {
    if (attr.type !== 'JSXAttribute') continue;
    const attrName = attr.name.type === 'JSXNamespacedName' ? `${attr.name.namespace.name}:${attr.name.name.name}` : attr.name.name;
    if (attrName === 'style') {
      report(attr, 'The `style` attribute is not allowed.', 'Use presentation attributes instead (fill={tokens.fg}, font-size="13").');
    } else if (/^on/i.test(attrName)) {
      report(attr, 'Event handlers are not allowed in widgets.', 'Remove it: widgets are static drawings; people comment and edit labels from Primer.');
    } else if (attrName === 'data-text-id' || attrName === 'data-anchor') {
      const literal = attr.value?.type === 'Literal' && typeof attr.value.value === 'string' ? (attr.value.value as string) : null;
      if (literal === null || !NAME.test(literal)) {
        report(
          attr,
          `\`${attrName}\` must be a literal name (letters, digits, _ and -, at most 64), never computed.`,
          `Write it out: ${attrName}="checkout". Words drawn from rows carry data-row and data-col instead.`,
        );
      } else if (attrName === 'data-text-id') {
        textId = literal;
      }
    } else if (COLOUR_ATTRS.has(attrName)) {
      const literal = literalString(attr.value);
      if (literal !== null && !isColourKeyword(literal)) {
        report(attr, `Literal colour "${literal}" in \`${attrName}\`.`, 'Use a theme token, e.g. fill={tokens.fg} or stroke={tokens.axis}, so the widget reads in light and dark.');
      }
    }
  }

  if (!intrinsic || UNDRAWN_TEXT_TAGS.has(tag)) return;
  let typed = '';
  let computed = false;
  let elements = false;
  for (const child of node.children as AstNode[]) {
    if (child.type === 'JSXText') typed += child.value;
    else if (child.type === 'JSXExpressionContainer') {
      if (child.expression.type === 'JSXEmptyExpression') continue;
      const literal = literalString(child.expression);
      if (literal !== null) typed += literal;
      else computed = true;
    } else elements = true;
  }
  const words = typed.replace(/\s+/g, ' ').trim();
  if (textId === null) {
    if (words) {
      report(node, `Typed words "${words.slice(0, 40)}" have no data-text-id.`, 'Give the element that holds them a literal data-text-id="<slug of the words>", so people can edit and comment on them.');
    }
    return;
  }
  if (computed || elements || !words) {
    report(
      node,
      `The element with data-text-id="${textId}" must hold only its typed words.`,
      elements
        ? 'One id per line: put a data-text-id on each <tspan>, not on the <text> that holds them.'
        : 'Words computed from rows take data-row and data-col, not a text id.',
    );
    return;
  }
  if (labels.has(textId)) {
    report(node, `data-text-id="${textId}" is used twice.`, 'Each label has its own id; a literal inside .map() draws one label many times.');
    return;
  }
  labels.set(textId, words);
}

function literalString(node: AstNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'JSXExpressionContainer') return literalString(node.expression);
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/** Colour values that are not colours: allowed anywhere. */
export function isColourKeyword(value: string): boolean {
  return value === 'none' || value === 'transparent' || value === 'currentColor' || /^url\(#[A-Za-z0-9_-]+\)$/.test(value);
}

function isClockOrRandom(node: AstNode): boolean {
  if (node.computed || node.object.type !== 'Identifier' || node.property.type !== 'Identifier') return false;
  return (node.object.name === 'Math' && node.property.name === 'random') || (node.object.name === 'Date' && node.property.name === 'now');
}

/** `x.fetch` or `{ fetch: 1 }` name a property, not the global. */
function isPropertyName(node: AstNode, parent: AstNode | null): boolean {
  if (!parent) return false;
  if (parent.type === 'MemberExpression') return parent.property === node && !parent.computed;
  if (parent.type === 'Property') return parent.key === node && !parent.computed && !parent.shorthand;
  if (parent.type === 'JSXAttribute') return parent.name === node;
  return false;
}

function walk(node: AstNode, parent: AstNode | null, visit: (node: AstNode, parent: AstNode | null) => void): void {
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child.type === 'string') walk(child, node, visit);
    }
  }
}
