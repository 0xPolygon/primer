import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UploadErrorResponse, UploadResponse } from '@primer/shared/api';
import { FileDropZone } from '../components/FileDropZone.tsx';
import { api } from '../lib/fetch.ts';

export function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Please choose an .html file.');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title);
      if (description) fd.append('description', description);

      const res = await api('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Partial<UploadErrorResponse>;
        setError(body.message ?? `Upload failed (${res.status}).`);
        return;
      }
      const body = (await res.json()) as UploadResponse;
      navigate(body.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = file !== null && title.trim().length > 0 && !submitting;

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-xl space-y-5">
      <h1 className="text-2xl font-semibold">Upload a document</h1>

      <FileDropZone file={file} onChange={setFile} />

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Title *</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
          className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700"
        />
      </label>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {submitting ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}
