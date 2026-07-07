import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from './AppShell.tsx';
import { HomePage } from './routes/home.tsx';
import { UploadPage } from './routes/upload.tsx';
import { DocumentPage } from './routes/document.tsx';
import { DevHarnessPage } from './routes/devHarness.tsx';
import { AdminPage } from './routes/admin.tsx';
import { DevicePage } from './routes/device.tsx';
import { TokenSettingsPage } from './routes/settings-tokens.tsx';
import { NotFoundPage } from './routes/notFound.tsx';
import CompareSelectPage from './routes/compareSelect.tsx';
import ComparePage from './routes/compare.tsx';
import { SharePage } from './routes/share.tsx';

const router = createBrowserRouter([
  { path: '/share/:shareToken', element: <SharePage /> },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/upload', element: <UploadPage /> },
      { path: '/d/:docId', element: <DocumentPage /> },
      { path: '/d/:docId/v/:versionNumber', element: <DocumentPage /> },
      { path: '/d/:docId/compare', element: <CompareSelectPage /> },
      { path: '/d/:docId/compare/:fromV/:toV', element: <ComparePage /> },
      { path: '/dev/harness', element: <DevHarnessPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '/device', element: <DevicePage /> },
      { path: '/settings/tokens', element: <TokenSettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
