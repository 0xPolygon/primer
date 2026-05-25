import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { resolveSnap, type SnapDef, type SnapPoint } from './BottomSheet.snap.ts';
import { useKeyboardInset } from '../lib/useKeyboardInset.ts';

export type { SnapPoint } from './BottomSheet.snap.ts';

interface BottomSheetCtx {
  snapTo: (s: SnapPoint) => void;
}
const Ctx = createContext<BottomSheetCtx | null>(null);

/** Imperative handle for descendants (e.g. ThreadCard) to drive sheet snap. */
export function useBottomSheet(): BottomSheetCtx | null {
  return useContext(Ctx);
}

interface Props {
  snap: SnapPoint;
  onSnapChange: (next: SnapPoint) => void;
  /** Label rendered on the handle bar (e.g. "💬 3 comments"). */
  handleLabel: ReactNode;
  /** Disable drag and tap-to-toggle. Used while composing. */
  dragLocked?: boolean;
  /** Dim backdrop shown at the `expanded` snap. Tapping dismisses to handle. */
  showBackdrop?: boolean;
  children: ReactNode;
}

const HANDLE_PX = 48;

export function BottomSheet({
  snap,
  onSnapChange,
  handleLabel,
  dragLocked = false,
  showBackdrop = true,
  children,
}: Props) {
  const keyboardInset = useKeyboardInset();
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);

  const snaps: SnapDef[] = [
    { name: 'handle', height: HANDLE_PX },
    { name: 'peek', height: Math.round(vh * 0.38) },
    { name: 'expanded', height: Math.round(vh * 0.88) },
  ];
  const snapHeight = (name: SnapPoint): number =>
    snaps.find((s) => s.name === name)?.height ?? HANDLE_PX;

  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const startRef = useRef<{ y: number; height: number; t: number } | null>(null);
  const lastRef = useRef<{ y: number; t: number } | null>(null);
  const didDragRef = useRef(false);

  const renderedHeight = dragHeight ?? snapHeight(snap);
  const dimmerVisible = showBackdrop && snap === 'expanded' && dragHeight === null;

  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (dragLocked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const now = performance.now();
    startRef.current = { y: e.clientY, height: snapHeight(snap), t: now };
    lastRef.current = { y: e.clientY, t: now };
    didDragRef.current = false;
    setDragHeight(snapHeight(snap));
  }

  function onPointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!startRef.current) return;
    const dy = e.clientY - startRef.current.y;
    if (!didDragRef.current && Math.abs(dy) > 3) {
      didDragRef.current = true;
    }
    // Drag-down = height shrinks; drag-up = height grows.
    const next = Math.max(HANDLE_PX, Math.min(vh, startRef.current.height - dy));
    setDragHeight(next);
    lastRef.current = { y: e.clientY, t: performance.now() };
  }

  function onPointerCancel(_e: ReactPointerEvent<HTMLButtonElement>) {
    startRef.current = null;
    lastRef.current = null;
    didDragRef.current = false;
    setDragHeight(null);
  }

  function onPointerUp(_e: ReactPointerEvent<HTMLButtonElement>) {
    const start = startRef.current;
    const last = lastRef.current;
    if (!start) return;
    let velocity = 0;
    if (last && last.t > start.t) {
      // px/ms; positive = pointer moved down = sheet shrinking.
      velocity = (last.y - start.y) / (last.t - start.t);
    }
    const next = resolveSnap({
      currentHeight: dragHeight ?? snapHeight(snap),
      velocity,
      snaps,
    });
    startRef.current = null;
    lastRef.current = null;
    setDragHeight(null);
    if (next !== snap) onSnapChange(next);
  }

  function onHandleClick() {
    if (dragLocked) return;
    if (didDragRef.current) { didDragRef.current = false; return; } // Click fired alongside drag — ignore.
    if (snap === 'handle') onSnapChange('peek');
    else onSnapChange('handle');
  }

  // Lock html scroll while the sheet is at expanded OR composing.
  useEffect(() => {
    if (snap !== 'expanded' && !dragLocked) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, [snap, dragLocked]);

  return (
    <Ctx.Provider value={{ snapTo: onSnapChange }}>
      {dimmerVisible && (
        <div
          className="fixed inset-0 z-30 bg-black/30"
          onClick={() => onSnapChange('handle')}
          aria-hidden
        />
      )}
      <div
        className="fixed left-0 right-0 z-40 flex flex-col overflow-hidden rounded-t-xl border-t border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
        style={{
          bottom: `${keyboardInset}px`,
          height: `${renderedHeight}px`,
          transition: dragHeight === null ? 'height 200ms ease' : 'none',
        }}
        role="dialog"
        aria-modal={snap === 'expanded'}
        aria-label="Comments"
      >
        <button
          type="button"
          onClick={onHandleClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          style={{ touchAction: 'none', height: `${HANDLE_PX}px` }}
          className="flex shrink-0 items-center justify-center gap-3 border-b border-neutral-200 px-3 text-xs text-neutral-700 dark:border-neutral-800 dark:text-neutral-300"
          aria-label="Drag to resize comments panel"
        >
          <span
            aria-hidden
            className="block h-1 w-10 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-700"
          />
          <span className="truncate">{handleLabel}</span>
        </button>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </Ctx.Provider>
  );
}
