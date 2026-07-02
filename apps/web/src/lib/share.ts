export function formatSharedWith(
  collabs: Array<{ userId: string; displayName: string }>,
  meId: string,
): string | null {
  const inList = collabs.some((c) => c.userId === meId);
  if (!inList) return null;
  const others = collabs.filter((c) => c.userId !== meId).map((c) => c.displayName);
  if (others.length === 0) return null;
  if (others.length === 1) return `Shared with ${others[0]}`;
  if (others.length === 2) return `Shared with ${others[0]} and ${others[1]}`;
  const extra = others.length - 2;
  const noun = extra === 1 ? 'other' : 'others';
  return `Shared with ${others[0]}, ${others[1]} and ${extra} ${noun}`;
}

export interface RoleOption {
  value: 'commenter' | 'editor';
  label: string;
  disabled: boolean;
  tooltip?: string;
}

export function roleOptions(visibility: 'org' | 'private'): RoleOption[] {
  const commenterDisabled = visibility === 'org';
  return [
    {
      value: 'commenter',
      label: 'Commenter',
      disabled: commenterDisabled,
      ...(commenterDisabled
        ? {
            tooltip:
              'Commenter is only meaningful under private visibility — everyone in the org can already read and comment on public docs.',
          }
        : {}),
    },
    { value: 'editor', label: 'Editor', disabled: false },
  ];
}
