import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { isPlausibleEmail, isCompleteCode, contentUrl, shareApi } from '../lib/shareViewer.ts';

type Step =
  | { kind: 'checking' }
  | { kind: 'email' }
  | { kind: 'code'; email: string }
  | { kind: 'ready'; documentTitle: string; published: boolean };

// BRAND PASS: Polygon wordmark SVG inlined (white mark + white text, for dark bg).
// Source: polygon-core:polygon-brand assets/logos/svg/polygon-logo-primary-light.svg
function PolygonWordmark() {
  return (
    <svg
      width="120"
      height="33"
      viewBox="0 0 729 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Polygon · Primer"
    >
      <path
        d="M89.2494 79.5209L75.937 71.8399L36 94.8805V140.959L75.937 164L115.877 140.959V69.2796L138.063 56.4803L160.252 69.2796V94.8805L138.063 107.68L124.751 100.001V120.479L138.063 128.16L178 105.119V59.0406L138.063 36L98.1259 59.0406V130.72L75.937 143.52L53.7506 130.72V105.119L75.937 92.3202L89.2494 99.9988V79.5209Z"
        fill="#6700E5"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M372.793 135.155H390.764V37H372.793V135.155ZM257.263 65.3834C265.78 65.3834 272.842 68.7927 278.426 75.601C284.021 82.4093 286.808 90.8549 286.808 100.938C286.808 111.021 284.011 119.466 278.426 126.275C272.831 133.083 265.78 136.492 257.263 136.492C251.231 136.492 245.989 134.637 241.559 130.917C237.212 127.114 234.019 121.984 231.971 115.528V161.684H214V66.7098H231.971V86.3368C234.009 79.8808 237.212 74.7927 241.559 71.0829C246 67.2798 251.231 65.3834 257.263 65.3834ZM250.732 120.171C255.609 120.171 259.738 118.358 263.107 114.731C266.477 111.021 268.162 106.42 268.162 100.938C268.162 95.456 266.477 91.0311 263.107 87.4041C259.738 83.6943 255.609 81.829 250.732 81.829C245.314 81.829 240.842 83.6425 237.285 87.2694C233.739 90.8964 231.96 95.4456 231.96 100.927C231.96 106.409 233.739 111.01 237.285 114.72C240.831 118.347 245.314 120.161 250.732 120.161V120.171ZM291.582 100.938C291.582 111.021 295.087 119.466 302.096 126.275C309.105 133.083 317.851 136.492 328.324 136.492C338.796 136.492 347.543 133.083 354.552 126.275C361.561 119.466 365.066 111.021 365.066 100.938C365.066 90.8549 361.561 82.4093 354.552 75.601C347.543 68.7927 338.796 65.3834 328.324 65.3834C317.851 65.3834 309.105 68.7927 302.096 75.601C295.087 82.4093 291.582 90.8549 291.582 100.938ZM315.408 114.731C311.944 111.021 310.218 106.42 310.218 100.938C310.218 95.456 311.944 91.0311 315.408 87.4041C318.871 83.6943 323.176 81.829 328.324 81.829C333.472 81.829 337.777 83.6425 341.24 87.2694C344.703 90.8964 346.43 95.4456 346.43 100.927C346.43 106.409 344.703 111.01 341.24 114.72C337.777 118.347 333.472 120.161 328.324 120.161C323.176 120.161 318.871 118.347 315.408 114.72V114.731ZM556.785 126.275C549.775 119.466 546.271 111.021 546.271 100.938C546.271 90.8549 549.775 82.4093 556.785 75.601C563.794 68.7927 572.54 65.3834 583.013 65.3834C593.485 65.3834 602.231 68.7927 609.241 75.601C616.25 82.4093 619.755 90.8549 619.755 100.938C619.755 111.021 616.25 119.466 609.241 126.275C602.231 133.083 593.485 136.492 583.013 136.492C572.54 136.492 563.804 133.083 556.785 126.275ZM564.896 100.938C564.896 106.42 566.623 111.021 570.086 114.731C573.549 118.358 577.854 120.171 583.002 120.171C588.15 120.171 592.456 118.358 595.919 114.731C599.382 111.021 601.108 106.42 601.108 100.938C601.108 95.456 599.382 90.8964 595.919 87.2798C592.456 83.6528 588.15 81.8394 583.002 81.8394C577.854 81.8394 573.549 83.6943 570.086 87.4145C566.623 91.0415 564.896 95.5492 564.896 100.948V100.938ZM667.583 65.3834C675.217 65.3834 681.342 68.0363 685.949 73.342C690.65 78.6477 693 85.4145 693 93.6321V135.145H675.029V96.8135C675.029 92.3886 673.615 88.7617 670.765 85.9326C667.926 83.1036 664.38 81.6839 660.116 81.6839C655.322 81.6839 651.422 83.1036 648.406 85.9326C645.39 88.7617 643.882 92.3886 643.882 96.8135V135.145H625.911V66.7098H643.882V84.2228C645.661 78.3886 648.635 73.7876 652.805 70.4301C657.069 67.0725 661.988 65.3938 667.583 65.3938V65.3834ZM433.933 116.907L452.299 66.772H470.54L432.737 161.746H414.496L424.084 137.601L395.995 66.772H415.432L433.933 116.907ZM521.644 66.7098V83.8601C517.9 72.6684 508.655 66.7098 496.352 66.7098C477.778 66.7098 466.796 82.8756 466.796 99.8705C466.796 116.865 477.695 134.358 496.352 134.358C508.655 134.358 517.9 125.518 521.644 114.326V127.456C521.644 133.031 519.824 137.622 516.184 141.249C512.544 144.876 508.114 146.689 502.873 146.689C495.77 146.689 490.497 143.155 487.034 136.078L470.925 144.565C473.941 150.14 478.246 154.596 483.841 157.964C489.436 161.321 495.78 163 502.873 163C513.345 163 522.091 159.601 529.101 152.782C536.11 145.974 539.615 137.528 539.615 127.446V66.7098H521.644ZM516.455 112.876C512.992 116.326 508.644 118.047 503.413 118.047C498.182 118.047 494.095 116.326 490.632 112.876C487.169 109.342 485.443 105.01 485.443 99.8808C485.443 94.7513 487.169 90.4611 490.632 87.0104C494.095 83.5596 498.349 81.8394 503.413 81.8394C508.478 81.8394 513.002 83.5596 516.455 87.0104C519.918 90.3679 521.644 94.658 521.644 99.8808C521.644 105.104 519.918 109.435 516.455 112.876Z"
        fill="white"
      />
    </svg>
  );
}

// BRAND PASS: sub-brand label using Polygon brand secondary text color.
function SubBrandLabel() {
  return (
    <span className="text-xs font-medium tracking-widest uppercase text-[#A0A1A6] ml-3">
      Primer
    </span>
  );
}

export function SharePage() {
  const { shareToken = '' } = useParams();
  useDocumentTitle('Shared document — Primer');
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await shareApi(`/api/share/${shareToken}/session`);
      const body = (await res.json().catch(() => null)) as
        | { authenticated: boolean; documentTitle?: string; published?: boolean }
        | null;
      if (cancelled) return;
      if (body?.authenticated) {
        setStep({ kind: 'ready', documentTitle: body.documentTitle ?? '', published: body.published ?? false });
      } else {
        setStep({ kind: 'email' });
      }
    })();
    return () => { cancelled = true; };
  }, [shareToken]);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!isPlausibleEmail(email) || busy) return;
    setBusy(true);
    setError(null);
    const res = await shareApi(`/api/share/${shareToken}/request-code`, {
      method: 'POST',
      body: JSON.stringify({ email: email.trim() }),
    });
    setBusy(false);
    if (res.status === 503) {
      setError('Email delivery is not available right now. Please contact the person who shared this document.');
      return;
    }
    if (res.status === 429) {
      setError('Too many requests. Please wait a minute and try again.');
      return;
    }
    // Enumeration-safe by design: we always proceed to the code screen.
    setStep({ kind: 'code', email: email.trim() });
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== 'code' || !isCompleteCode(code) || busy) return;
    setBusy(true);
    setError(null);
    const res = await shareApi(`/api/share/${shareToken}/verify`, {
      method: 'POST',
      body: JSON.stringify({ email: step.email, code }),
    });
    setBusy(false);
    if (res.ok) {
      // Cookie is set; the content endpoint takes it from here (top-level nav).
      window.location.assign(contentUrl(shareToken));
      return;
    }
    if (res.status === 429) {
      setError('Too many attempts. Please wait a minute and try again.');
    } else {
      setError("That code didn't work. Check it and try again, or request a new one.");
    }
  }

  return (
    // BRAND PASS: dark theme shell — bg-[#141415] (Grey 600), full viewport height.
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#141415] px-4 py-12">
      {/* BRAND PASS: Polygon wordmark + Primer sub-brand at top */}
      <div className="flex items-center mb-10">
        <PolygonWordmark />
        <span className="ml-2 text-[#353535] text-xl select-none" aria-hidden="true">·</span>
        <SubBrandLabel />
      </div>

      {/* BRAND PASS: card uses Grey 500 surface (#1F1E20), Stroke border (#1B1B1D) */}
      <div className="w-full max-w-md rounded-2xl border border-[#1B1B1D] bg-[#1F1E20] p-8 shadow-xl">
        {step.kind === 'checking' && (
          // BRAND PASS: secondary text color Grey 200 (#A0A1A6)
          <p className="text-sm text-[#A0A1A6]">Checking access…</p>
        )}

        {step.kind === 'email' && (
          <form onSubmit={submitEmail}>
            {/* BRAND PASS: headings in white (#FFFFFF), body in Grey 100 (#F2F3F7) */}
            <h1 className="text-lg font-semibold text-[#FFFFFF] mb-1">A document has been shared with you</h1>
            <p className="text-sm text-[#A0A1A6] mb-6">
              Enter your email address. If it has access, we'll send you a verification code.
            </p>
            {/* BRAND PASS: input with Stroke border, Grey 300 placeholder, white text */}
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full rounded-lg border border-[#353535] bg-[#141415] text-[#F2F3F7] placeholder:text-[#595A5F] px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-1 focus:ring-[#6700E5] focus:border-[#6700E5]"
            />
            {/* BRAND PASS: primary button — POL Purple (#6700E5), white text */}
            <button
              type="submit"
              disabled={!isPlausibleEmail(email) || busy}
              className="w-full rounded-lg bg-[#6700E5] text-white py-2 text-sm font-medium disabled:opacity-40 hover:bg-[#5500C0] transition-colors"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        )}

        {step.kind === 'code' && (
          <form onSubmit={submitCode}>
            <h1 className="text-lg font-semibold text-[#FFFFFF] mb-1">Check your email</h1>
            <p className="text-sm text-[#A0A1A6] mb-6">
              If <span className="font-medium text-[#F2F3F7]">{step.email}</span> has access, we've sent it a 6-digit code.
              The code expires in 10 minutes.
            </p>
            {/* BRAND PASS: OTP input — centered, large tracking, Stroke border */}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-full rounded-lg border border-[#353535] bg-[#141415] text-[#F2F3F7] placeholder:text-[#595A5F] px-3 py-2 text-center text-xl tracking-[0.5em] mb-4 focus:outline-none focus:ring-1 focus:ring-[#6700E5] focus:border-[#6700E5]"
            />
            {/* BRAND PASS: primary CTA — POL Purple (#6700E5) */}
            <button
              type="submit"
              disabled={!isCompleteCode(code) || busy}
              className="w-full rounded-lg bg-[#6700E5] text-white py-2 text-sm font-medium disabled:opacity-40 hover:bg-[#5500C0] transition-colors"
            >
              {busy ? 'Verifying…' : 'View document'}
            </button>
            {/* BRAND PASS: ghost link — Grey 200 secondary text */}
            <button
              type="button"
              onClick={() => { setStep({ kind: 'email' }); setCode(''); setError(null); }}
              className="w-full mt-3 text-xs text-[#A0A1A6] underline hover:text-[#F2F3F7] transition-colors"
            >
              Use a different email or request a new code
            </button>
          </form>
        )}

        {step.kind === 'ready' && (
          <div>
            <h1 className="text-lg font-semibold text-[#FFFFFF] mb-1">{step.documentTitle || 'Shared document'}</h1>
            {step.published ? (
              <>
                <p className="text-sm text-[#A0A1A6] mb-6">You're verified on this device.</p>
                {/* BRAND PASS: primary action link — POL Purple (#6700E5) */}
                <a
                  href={contentUrl(shareToken)}
                  className="block w-full rounded-lg bg-[#6700E5] text-white py-2 text-center text-sm font-medium hover:bg-[#5500C0] transition-colors"
                >
                  Open document
                </a>
              </>
            ) : (
              <p className="text-sm text-[#A0A1A6]">
                Nothing is published to this share yet. Check back later, or contact the person who shared it.
              </p>
            )}
          </div>
        )}

        {/* BRAND PASS: error text uses a warm destructive red that contrasts on dark bg */}
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
