import { Link } from 'react-router-dom';

export function HomePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold">Primer</h1>
      <p className="text-neutral-600">
        Upload an LLM-generated HTML artifact and share it across Polygon.
      </p>
      <Link
        to="/upload"
        className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-800"
      >
        Upload a new document
      </Link>
    </div>
  );
}
