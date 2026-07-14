import { useEffect, useRef, useState } from 'react';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  Theme,
} from '@primer/shared';
import { parseInboundMessage, parseWindowEnvelope } from '@primer/shared';
import { createMessageBuffer } from '../companion/buffer.ts';
import {
  computeFitScale,
  fitIframeStyle,
  hasResidualOverflow,
  nextFitState,
  type FitState,
} from '../lib/fitToWidth.ts';

interface Props {
  src: string;
  anchors: Anchor[];
  theme: Theme;
  onMessage: (msg: InboundProtocolMessage) => void;
  /** Imperative outbound channel. Parent stores a setter; child stores the sender. */
  registerSender?: (send: ((msg: OutboundProtocolMessage) => void) | null) => void;
  /** Scale content down (to at most 0.5×) when the artifact is intrinsically
   * wider than the container. Enabled by the document route on mobile. */
  fitToWidth?: boolean;
}

// SECURITY-CRITICAL: The sandbox value below is the primary defense against
// hostile JS inside uploaded artifacts. Do NOT add `allow-same-origin`,
// `allow-popups`, or `allow-popups-to-escape-sandbox`. Adding any of these
// would re-open phishing / cookie-theft / fake-SSO vectors described in
// docs/prd-primer.md ("Iframe sandboxing"). If you find yourself needing
// to widen the sandbox further, stop and consult the threat model first.
//
// `allow-modals` enables `window.print()` (and alert/confirm/prompt) inside
// the iframe — required for in-artifact "Print / Save as PDF" buttons.
// `allow-downloads` enables `<a download>.click()` on blob URLs — required
// for in-artifact "Export to Excel/CSV" buttons that build a file in memory.
// Both tokens are scoped to the iframe's opaque origin: they do not grant
// access to parent cookies, storage, or DOM and do not open the
// fake-SSO-popup vector that the three forbidden tokens above would.
export function ArtifactIframe({ src, anchors, theme, onMessage, registerSender, fitToWidth }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);

  // Latest-value refs so deferred handlers see current props, not the values
  // closed over at mount.
  const anchorsRef = useRef(anchors);
  const themeRef = useRef(theme);
  const onMessageRef = useRef(onMessage);
  const registerSenderRef = useRef(registerSender);
  useEffect(() => { anchorsRef.current = anchors; }, [anchors]);
  useEffect(() => { themeRef.current = theme; }, [theme]);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { registerSenderRef.current = registerSender; }, [registerSender]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<FitState>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const fitToWidthRef = useRef(fitToWidth === true);
  useEffect(() => { fitToWidthRef.current = fitToWidth === true; }, [fitToWidth]);

  // New document/version → forget the previous artifact's width.
  useEffect(() => { setFit(null); }, [src]);

  // Track the wrapper's width so the scale follows rotation and layout
  // changes. Observing unconditionally keeps hook order stable and is cheap.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Per-mount state. Buffer drops messages older than 50 if the handshake
    // never completes; sendInit is idempotent so duplicate triggers are safe.
    const buffer = createMessageBuffer<OutboundProtocolMessage>(50);
    let initSent = false;

    const sendInit = () => {
      if (initSent) return;
      if (!iframe.contentWindow) return;
      initSent = true;

      const channel = new MessageChannel();
      const port = channel.port1;
      portRef.current = port;

      port.onmessage = (event) => {
        const parsed = parseInboundMessage(event.data);
        if (!parsed) return;
        if (parsed.type === 'content_metrics') {
          // Rendering concern owned by this component — not forwarded.
          if (fitToWidthRef.current) {
            setFit((cur) =>
              nextFitState(cur, parsed.contentWidth, wrapRef.current?.clientWidth ?? 0),
            );
          }
          return;
        }
        onMessageRef.current(parsed);
      };
      port.start();

      iframe.contentWindow.postMessage(
        {
          type: 'init',
          anchors: anchorsRef.current,
          theme: themeRef.current,
        } satisfies OutboundProtocolMessage,
        '*',
        [channel.port2],
      );

      // Wire the sender for the parent route. The cleanup function
      // deregisters this sender BEFORE closing the port, so callers can rely
      // on the port being live whenever this sender is reachable.
      registerSenderRef.current?.((msg) => port.postMessage(msg));
      buffer.drain((msg) => port.postMessage(msg));
    };

    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const envelope = parseWindowEnvelope(event.data);
      if (!envelope) return;
      if (envelope.type === 'companion_ready') {
        sendInit();
      } else if (envelope.type === 'companion_panic') {
        // eslint-disable-next-line no-console
        console.error('[companion] panic:', envelope.reason);
      }
    };

    const onLoad = () => sendInit();

    window.addEventListener('message', onWindowMessage);
    iframe.addEventListener('load', onLoad);

    return () => {
      window.removeEventListener('message', onWindowMessage);
      iframe.removeEventListener('load', onLoad);
      // Deregister the sender BEFORE closing the port so any caller still
      // holding a reference to the sender cannot post to a dead port.
      registerSenderRef.current?.(null);
      portRef.current?.close();
      portRef.current = null;
    };
  }, [src]);

  // Push theme changes to the companion. The init handshake already carries
  // the current theme; this effect propagates subsequent toggles. The first
  // run (initial mount) is harmless — the companion may not yet be ready.
  useEffect(() => {
    portRef.current?.postMessage({ type: 'theme_changed', theme } satisfies OutboundProtocolMessage);
  }, [theme]);

  const scale = fitToWidth ? computeFitScale(fit, containerWidth) : 1;
  const fitStyle = fitIframeStyle(scale, fit);
  const allowPanX = fitToWidth ? hasResidualOverflow(scale, fit, containerWidth) : false;

  return (
    <div
      ref={wrapRef}
      className="h-full w-full"
      style={{ overflowX: allowPanX ? 'auto' : 'hidden', overflowY: 'hidden' }}
    >
      <iframe
        ref={iframeRef}
        src={src}
        sandbox="allow-scripts allow-forms allow-modals allow-downloads"
        title="Artifact"
        style={{ border: 0, display: 'block', ...fitStyle }}
      />
    </div>
  );
}
