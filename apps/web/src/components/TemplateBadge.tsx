import type { DocumentTemplate } from '@primer/shared';

/**
 * Non-clickable chip shown in the document header when the viewed version was
 * built with a template. A color swatch + label, tinted with the template's
 * accent color. The badge follows the viewed version (see document.tsx), so an
 * older untemplated version shows nothing.
 */
export function TemplateBadge({ template }: { template: DocumentTemplate }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300"
      style={{
        borderColor: `${template.color}55`,
        backgroundColor: `${template.color}14`,
      }}
      title={`Built with the ${template.label} template`}
      aria-label={`Template: ${template.label}`}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: template.color }}
        aria-hidden="true"
      />
      {template.label}
    </span>
  );
}
