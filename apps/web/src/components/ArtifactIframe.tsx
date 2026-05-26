import { useEffect, useRef } from 'react';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  Theme,
} from '@primer/shared';
import { parseInboundMessage, parseWindowEnvelope } from '@primer/shared';
import { createMessageBuffer } from '../companion/buffer.ts';

interface Props {
  src: string;
  anchors: Anchor[];
  theme: Theme;
  onMessage: (msg: InboundProtocolMessage) => void;
  /** Imperative outbound channel. Parent stores a setter; child stores the sender. */
  registerSender?: (send: ((msg: OutboundProtocolMessage) => void) | null) => void;
}

// SECURITY-CRITICAL: The sandbox value below is the primary defense against
// hostile JS inside uploaded artifacts. Do NOT add `allow-same-origin`,
// `allow-popups`, or `allow-popups-to-escape-sandbox`. Adding any of these
// would re-open phishing / cookie-theft / fake-SSO vectors described in
// docs/prd-primer.md ("Iframe sandboxing"). If you find yourself needing
// to widen the sandbox, stop and consult the threat model first.
export function ArtifactIframe({ src, anchors, theme, onMessage, registerSender }: Props) {
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
        if (parsed) onMessageRef.current(parsed);
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

  return (
    <iframe
      ref={iframeRef}
      src={src}
      sandbox="allow-scripts allow-forms"
      title="Artifact"
      style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }}
    />
  );
}
