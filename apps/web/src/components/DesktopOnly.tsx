import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  children: ReactNode;
}

export function DesktopOnly({ children }: Props) {
  return (
    <>
      <div className="md:hidden mx-auto max-w-md py-12 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          This view isn't ready for mobile. Open Primer on a larger screen to use it.
        </p>
        <Link
          to="/"
          className="mt-4 inline-block rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-300"
        >
          Back to home
        </Link>
      </div>
      <div className="hidden md:block">{children}</div>
    </>
  );
}
