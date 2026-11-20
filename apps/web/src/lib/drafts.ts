import { createContext, useContext, useEffect, useId } from 'react';

/**
 * Lets comment inputs deep in the sidebar (a reply or an edit in a
 * ThreadCard) tell the document page they hold unsent text, so a newly
 * published version never replaces the view under a half-typed comment
 * (lib/viewedVersion.ts followNewVersion). The page provides the reporter
 * and keeps the set of dirty inputs.
 */
export const DraftReporterContext = createContext<(key: string, dirty: boolean) => void>(() => {});

/** The page's side: the set of inputs holding unsent text. `report` is
 *  the DraftReporterContext value; `any()` is read live when deciding
 *  whether to follow a new version. */
export function createDraftTracker(): { report: (key: string, dirty: boolean) => void; any: () => boolean } {
  const dirty = new Set<string>();
  return {
    report: (key, isDirty) => {
      if (isDirty) dirty.add(key);
      else dirty.delete(key);
    },
    any: () => dirty.size > 0,
  };
}

/** Reports this input's draft state while it is mounted. */
export function useReportDraft(dirty: boolean): void {
  const report = useContext(DraftReporterContext);
  const key = useId();
  useEffect(() => {
    report(key, dirty);
    return () => report(key, false);
  }, [report, key, dirty]);
}
