import { useEffect, useRef, useState, type DragEvent } from 'react';

interface Props {
  file: File | null;
  onChange: (file: File | null) => void;
  /** Max bytes; default 10 MiB */
  maxBytes?: number;
  /** Disabled state */
  disabled?: boolean;
}

const TEN_MIB = 10 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validate(file: File, maxBytes: number): string | null {
  const lowerName = file.name.toLowerCase();
  const ok =
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    lowerName.endsWith('.txt');
  if (!ok) return 'Only .html, .md, .markdown, or .txt files are accepted.';
  if (file.size > maxBytes) {
    return `This file is ${formatSize(file.size)} — limit is ${formatSize(maxBytes)}.`;
  }
  return null;
}

export function FileDropZone({ file, onChange, maxBytes = TEN_MIB, disabled = false }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) {
      setError(null);
      return;
    }
    setError(validate(file, maxBytes));
  }, [file, maxBytes]);

  function handlePick(f: File | null) {
    if (disabled) return;
    if (!f) {
      onChange(null);
      return;
    }
    const v = validate(f, maxBytes);
    setError(v);
    onChange(v ? null : f);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0] ?? null;
    handlePick(f);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (disabled) return;
    setIsDragging(true);
  }

  function handleDragLeave() {
    setIsDragging(false);
  }

  function openPicker() {
    if (disabled) return;
    inputRef.current?.click();
  }

  const borderClass = error
    ? 'border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-900/20'
    : isDragging
      ? 'border-yellow-500 bg-yellow-50 dark:bg-amber-900/20'
      : 'border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Upload HTML or Markdown file"
        aria-invalid={error !== null}
        aria-describedby={error ? 'filedropzone-error' : undefined}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`flex h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${borderClass} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        {!file ? (
          <>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mb-2 text-neutral-500" aria-hidden="true">
              <path d="M12 5v14M5 12l7-7 7 7" />
            </svg>
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {isDragging ? 'Drop to attach' : 'Drop an HTML or Markdown file here, or click to browse'}
            </p>
            <p className="mt-1 text-xs text-neutral-500">.html / .md / .txt files up to {formatSize(maxBytes)}</p>
          </>
        ) : (
          <div className="flex w-full items-center gap-3 px-4">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-neutral-600 dark:text-neutral-400" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">{file.name}</div>
              <div className="text-xs text-neutral-500">{formatSize(file.size)}</div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openPicker();
              }}
              className="text-xs font-medium text-neutral-600 dark:text-neutral-400 underline hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Replace
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".html,text/html,.md,.markdown,text/markdown,text/x-markdown,.txt,text/plain"
          className="hidden"
          onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
        />
      </div>
      {error && (
        <p id="filedropzone-error" role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div aria-live="polite" className="sr-only">
        {isDragging ? 'Drop to attach the file.' : ''}
      </div>
    </div>
  );
}
