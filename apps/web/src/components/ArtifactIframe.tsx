interface Props {
  versionId: string;
}

// SECURITY-CRITICAL: The sandbox value below is the primary defense against
// hostile JS inside uploaded artifacts. Do NOT add `allow-same-origin`,
// `allow-popups`, or `allow-popups-to-escape-sandbox`. Adding any of these
// would re-open phishing / cookie-theft / fake-SSO vectors described in
// docs/prd-primer.md ("Iframe sandboxing"). If you find yourself needing
// to widen the sandbox, stop and consult the threat model first.
export function ArtifactIframe({ versionId }: Props) {
  return (
    <iframe
      src={`/api/versions/${versionId}/content`}
      sandbox="allow-scripts allow-forms"
      title="Artifact"
      style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }}
    />
  );
}
