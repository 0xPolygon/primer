import { useEffect, useRef } from 'react';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
} from '@primer/shared';
import { parseInboundMessage } from '@primer/shared';

interface Props {
  src: string;
  anchors: Anchor[];
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
export function ArtifactIframe({ src, anchors, onMessage, registerSender }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);

  // Latest-value refs so `handleLoad` (which only registers on src change) sees
  // the current prop values when the iframe finishes loading the artifact
  // bytes — not the stale values from when the effect first ran. This matters
  // because threads usually resolve AFTER the iframe is mounted but BEFORE its
  // content finishes loading; without these refs, init would post empty
  // anchors and the companion would never paint until something else triggered
  // an update.
  const anchorsRef = useRef(anchors);
  const onMessageRef = useRef(onMessage);
  const registerSenderRef = useRef(registerSender);
  useEffect(() => { anchorsRef.current = anchors; }, [anchors]);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { registerSenderRef.current = registerSender; }, [registerSender]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      const channel = new MessageChannel();
      const port = channel.port1;
      portRef.current = port;

      port.onmessage = (event) => {
        const parsed = parseInboundMessage(event.data);
        if (parsed) onMessageRef.current(parsed);
      };
      port.start();

      iframe.contentWindow?.postMessage(
        { type: 'init', anchors: anchorsRef.current } satisfies OutboundProtocolMessage,
        '*',
        [channel.port2]
      );

      registerSenderRef.current?.((msg) => port.postMessage(msg));
    };

    iframe.addEventListener('load', handleLoad);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      portRef.current?.close();
      portRef.current = null;
      registerSenderRef.current?.(null);
    };
  }, [src]);

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
