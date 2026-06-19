interface BarItem {
  key: string;        // stable React key
  label: string;      // visible label
  value: number;
}

interface Props {
  items: BarItem[];
  formatValue?: (n: number) => string;
  emptyText?: string;
}

export function BarList({ items, formatValue, emptyText = 'No activity in this window.' }: Props) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{emptyText}</p>
    );
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  const fmt = formatValue ?? ((n: number) => n.toLocaleString());
  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const pct = (item.value / max) * 100;
        return (
          <li key={item.key} className="grid grid-cols-[1fr_auto] items-center gap-2">
            <div className="relative h-6 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
              <div
                className="absolute inset-y-0 left-0 bg-blue-200 dark:bg-blue-900"
                style={{ width: `${pct}%` }}
              />
              <div className="relative z-10 truncate px-2 py-0.5 text-xs text-neutral-900 dark:text-neutral-100">
                {item.label}
              </div>
            </div>
            <span className="text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
              {fmt(item.value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
