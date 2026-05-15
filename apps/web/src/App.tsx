import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from './AppShell.tsx';
import { HomePage } from './routes/home.tsx';
import { UploadPage } from './routes/upload.tsx';
import { DocumentPage } from './routes/document.tsx';
import { DevHarnessPage } from './routes/devHarness.tsx';
import { NotFoundPage } from './routes/notFound.tsx';

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/upload', element: <UploadPage /> },
      { path: '/d/:docId', element: <DocumentPage /> },
      { path: '/dev/harness', element: <DevHarnessPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
