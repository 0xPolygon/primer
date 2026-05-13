import { useParams } from 'react-router-dom';
import { useDocument } from '../queries/documents.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';

export function DocumentPage() {
  const { docId } = useParams();
  const q = useDocument(docId ?? '');

  if (q.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (q.error) {
    return (
      <div className="text-red-600">
        Could not load document: {(q.error as Error).message}
      </div>
    );
  }
  if (!q.data) return null;

  const { document, latestVersion } = q.data;

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between border-b border-neutral-200 pb-2">
        <div>
          <h1 className="text-xl font-semibold">{document.title}</h1>
          {document.description && (
            <p className="text-sm text-neutral-600">{document.description}</p>
          )}
        </div>
        <div className="text-sm text-neutral-500">
          {document.uploaderDisplayName} ·{' '}
          {new Date(document.createdAt).toLocaleString()}
        </div>
      </header>
      <ArtifactIframe versionId={latestVersion.id} />
    </div>
  );
}
