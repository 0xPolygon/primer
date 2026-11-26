import { t } from '../i18n';
import type { CollaboratorRole } from '@polygonlabs/primer-api-types';

export function formatSharedWith(
  collabs: Array<{ userId: string; displayName: string }>,
  meId: string,
): string | null {
  const inList = collabs.some((c) => c.userId === meId);
  if (!inList) return null;
  const others = collabs.filter((c) => c.userId !== meId).map((c) => c.displayName);
  if (others.length === 0) return null;
  if (others.length === 1) return t('libShare.sharedWithOne', { name: others[0] });
  if (others.length === 2) return t('libShare.sharedWithTwo', { first: others[0], second: others[1] });
  const extra = others.length - 2;
  const key = extra === 1 ? 'libShare.sharedWithMoreOne' : 'libShare.sharedWithMoreMany';
  return t(key, { first: others[0], second: others[1], extra });
}

export interface RoleOption {
  value: CollaboratorRole;
  label: string;
  disabled: boolean;
  tooltip?: string;
}

export function roleOptions(visibility: 'org' | 'private'): RoleOption[] {
  const commenterDisabled = visibility === 'org';
  return [
    {
      value: 'commenter',
      label: t('libShare.commenter'),
      disabled: commenterDisabled,
      ...(commenterDisabled
        ? {
            tooltip:
              t('libShare.commenterTooltip'),
          }
        : {}),
    },
    {
      value: 'responder',
      label: t('libShare.responder'),
      disabled: false,
      tooltip:
        t('libShare.responderTooltip'),
    },
    { value: 'editor', label: t('libShare.editor'), disabled: false },
  ];
}
