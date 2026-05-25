import { Outlet, Link } from 'react-router-dom';
import { UserMenu } from './components/UserMenu.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { PrimerIcon } from './components/PrimerIcon.tsx';

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-3 sm:px-6 py-3 flex items-center justify-between">
        <Link
          to="/"
          className="flex items-center gap-2 font-semibold text-neutral-800 dark:text-neutral-200"
        >
          <PrimerIcon size={22} className="text-neutral-700 dark:text-neutral-300" />
          <span>Primer</span>
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <main className="flex-1 p-3 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
