import { Outlet, Link } from 'react-router-dom';
import { UserMenu } from './components/UserMenu.tsx';

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 px-6 py-3 flex items-center justify-between">
        <Link to="/" className="font-semibold">
          Primer
        </Link>
        <UserMenu />
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
