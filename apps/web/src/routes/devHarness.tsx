import { useCallback, useRef, useState } from 'react';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  TextRangeAnchor,
  ElementPathAnchor,
  SerializableRect,
} from '@primer/shared';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';

interface LogEntry {
  ts: number;
  dir: 'in' | 'out';
  type: string;
  payload: unknown;
}

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

let synthSeq = 0;
function nextSynthId(): string {
  synthSeq += 1;
  return `harness-${Date.now()}-${synthSeq}`;
}

export function DevHarnessPage() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [pickMode, setPickMode] = useState(false);

  const senderRef = useRef<((msg: OutboundProtocolMessage) => void) | null>(null);

  const appendLog = useCallback((entry: LogEntry) => {
    setLog((l) => [entry, ...l].slice(0, 100));
  }, []);

  const send = useCallback(
    (msg: OutboundProtocolMessage) => {
      const s = senderRef.current;
      if (!s) {
        appendLog({ ts: Date.now(), dir: 'out', type: msg.type + ' (DROPPED — no port)', payload: msg });
        return;
      }
      s(msg);
      appendLog({ ts: Date.now(), dir: 'out', type: msg.type, payload: msg });
    },
    [appendLog]
  );

  const registerSender = useCallback(
    (s: ((msg: OutboundProtocolMessage) => void) | null) => {
      senderRef.current = s;
    },
    []
  );

  const onMessage = useCallback(
    (msg: InboundProtocolMessage) => {
      appendLog({ ts: Date.now(), dir: 'in', type: msg.type, payload: msg });
      switch (msg.type) {
        case 'selection_captured':
          setPendingSelection({ anchor: msg.anchor, clientRects: msg.clientRects });
          break;
        case 'element_picked':
          setPendingPick({ anchor: msg.anchor, clientRect: msg.clientRect });
          setPickMode(false);
          break;
        case 'pick_mode_exited':
          setPickMode(false);
          break;
        case 'open_external':
          if (!isSafeExternalUrl(msg.url)) {
            appendLog({
              ts: Date.now(),
              dir: 'in',
              type: 'open_external (REJECTED — non-https)',
              payload: msg,
            });
            return;
          }
          handleOpenExternal(msg);
          break;
        case 'resize':
        case 'anchor_positions':
          // Already logged above; no UI consequence in the harness.
          break;
      }
    },
    [appendLog]
  );

  const saveSelection = () => {
    if (!pendingSelection) return;
    const id = nextSynthId();
    const next = [...anchors, { id, data: pendingSelection.anchor }];
    setAnchors(next);
    setPendingSelection(null);
    send({ type: 'update_anchors', anchors: next });
  };

  const savePick = () => {
    if (!pendingPick) return;
    const id = nextSynthId();
    const next = [...anchors, { id, data: pendingPick.anchor }];
    setAnchors(next);
    setPendingPick(null);
    send({ type: 'update_anchors', anchors: next });
  };

  const dropAnchor = (id: string) => {
    const next = anchors.filter((a) => a.id !== id);
    setAnchors(next);
    send({ type: 'update_anchors', anchors: next });
  };

  const highlight = (id: string) => send({ type: 'set_focused_anchor', anchorId: id });

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <ArtifactIframe
          src="/dev/fixtures/anchoring.html"
          anchors={anchors}
          onMessage={onMessage}
          registerSender={registerSender}
        />
      </div>
      <div className="space-y-4 overflow-y-auto" style={{ height: 'calc(100vh - 120px)' }}>
        <section>
          <h2 className="font-semibold mb-1">Current selection</h2>
          {pendingSelection ? (
            <div className="rounded border border-neutral-200 p-2">
              <pre className="text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(pendingSelection.anchor, null, 2)}
              </pre>
              <div className="mt-2 flex gap-2">
                <button onClick={saveSelection} className="rounded bg-neutral-900 px-3 py-1 text-white">
                  Save as anchor
                </button>
                <button onClick={() => setPendingSelection(null)} className="rounded border px-3 py-1">
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">No selection captured yet.</p>
          )}
        </section>

        <section>
          <h2 className="font-semibold mb-1">Saved anchors ({anchors.length})</h2>
          {anchors.length === 0 && <p className="text-sm text-neutral-500">None yet.</p>}
          <ul className="space-y-1">
            {anchors.map((a) => (
              <li key={a.id} className="rounded border border-neutral-200 p-2 text-xs">
                <div className="font-mono">
                  {a.id} — {a.data.type}
                </div>
                <div className="truncate text-neutral-600">
                  {a.data.type === 'text-range' ? `"${a.data.selectorText}"` : a.data.path}
                </div>
                <div className="mt-1 flex gap-2">
                  <button onClick={() => highlight(a.id)} className="rounded border px-2">
                    Highlight
                  </button>
                  <button onClick={() => dropAnchor(a.id)} className="rounded border px-2">
                    Drop
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="font-semibold mb-1">Pick mode</h2>
          <button
            onClick={togglePickMode}
            className={`rounded px-3 py-1 ${pickMode ? 'bg-red-600 text-white' : 'bg-neutral-900 text-white'}`}
          >
            {pickMode ? 'Exit pick mode' : 'Enter pick mode'}
          </button>
          {pendingPick && (
            <div className="mt-2 rounded border border-neutral-200 p-2">
              <pre className="text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(pendingPick.anchor, null, 2)}
              </pre>
              <button onClick={savePick} className="mt-2 rounded bg-neutral-900 px-3 py-1 text-white">
                Save as anchor
              </button>
            </div>
          )}
        </section>

        <section>
          <h2 className="font-semibold mb-1">Message log</h2>
          <ul className="space-y-1">
            {log.map((e, i) => (
              <li key={i} className="rounded border border-neutral-200 p-1 text-xs">
                <span className="font-mono text-neutral-500">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>{' '}
                <span className="font-semibold">
                  {e.dir === 'in' ? '←' : '→'} {e.type}
                </span>
                <details>
                  <summary className="text-neutral-500">payload</summary>
                  <pre className="whitespace-pre-wrap break-words">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
