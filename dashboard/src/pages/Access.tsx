import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { getAccess, updateAccess } from '../api/client.js';
import type { AccessConfig } from '../api/client.js';

const FUNNEL_CONFIRM_TEXT = 'enable funnel';

export default function Access() {
  const [access, setAccess] = useState<AccessConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [showFunnelModal, setShowFunnelModal] = useState(false);
  const [funnelConfirmText, setFunnelConfirmText] = useState('');

  useEffect(() => {
    getAccess().then(r => {
      setAccess(r.access);
      setManualUrl(r.access.manualBaseUrl ?? '');
    }).catch(() => {});
  }, []);

  function validateUrl(url: string): string {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Must be http: or https:';
      if (parsed.username || parsed.password) return 'Must not contain credentials';
      if (parsed.search || parsed.hash) return 'Must not contain query string or fragment';
      if (parsed.pathname !== '/' && parsed.pathname !== '') return 'Must not contain a path';
      return '';
    } catch {
      return 'Invalid URL';
    }
  }

  async function handleSave() {
    if (!access) return;
    const err = validateUrl(manualUrl);
    if (err) { setUrlError(err); return; }
    setSaving(true);
    setError('');
    try {
      await updateAccess({ ...access, ...(manualUrl ? { manualBaseUrl: manualUrl } : {}) });
      const r = await getAccess();
      setAccess(r.access);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  async function handleEnableFunnel() {
    if (!access) return;
    try {
      await updateAccess({ ...access, tailscale: { ...access.tailscale, funnelConfigured: true } });
      const r = await getAccess();
      setAccess(r.access);
      setShowFunnelModal(false);
      setFunnelConfirmText('');
    } catch (e) { setError(String(e)); }
  }

  if (!access) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>External Access</h1>

      <section style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Provider</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['localhost', 'tailscale', 'manual'] as const).map(p => (
            <button key={p} onClick={() => setAccess({ ...access, provider: p })}
              style={{ padding: '7px 16px', borderRadius: 6, border: 'none', fontWeight: 600, fontSize: 13,
                background: access.provider === p ? '#2563eb' : '#27272a',
                color: access.provider === p ? '#fff' : '#a1a1aa' }}>
              {p}
            </button>
          ))}
        </div>
      </section>

      {access.provider === 'manual' && (
        <section style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Manual base URL</h2>
          <input
            type="url"
            value={manualUrl}
            onChange={e => { setManualUrl(e.target.value); setUrlError(''); }}
            onBlur={e => setUrlError(validateUrl(e.target.value))}
            placeholder="https://your-server.example.com"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: `1px solid ${urlError ? '#dc2626' : '#3f3f46'}`, background: '#0f0f0f', color: '#e4e4e7', fontSize: 13 }}
          />
          {urlError && <p style={{ fontSize: 12, color: '#f87171', marginTop: 4 }}>{urlError}</p>}
        </section>
      )}

      {access.provider === 'tailscale' && (
        <section style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Tailscale</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Row label="Serve configured" value={access.tailscale.serveConfigured ? '✓ Yes' : '✗ No'} />
            <Row label="Funnel configured" value={access.tailscale.funnelConfigured ? '✓ Yes' : '✗ No'} />
            {!access.tailscale.serveConfigured && (
              <InfoBox>
                <p style={{ fontSize: 13 }}>Run the following command to configure Tailscale Serve:</p>
                <code style={{ display: 'block', marginTop: 8, padding: '8px 12px', background: '#0f0f0f', borderRadius: 6, fontSize: 12 }}>
                  tailscale serve --bg {window.location.port || 8050}
                </code>
                <button onClick={() => {
                  void updateAccess({ ...access, tailscale: { ...access.tailscale, serveConfigured: true } })
                    .then(() => getAccess())
                    .then(r => setAccess(r.access))
                    .catch(() => {});
                }}
                  style={{ marginTop: 10, padding: '6px 12px', borderRadius: 5, background: '#27272a', border: 'none', color: '#60a5fa', fontSize: 13 }}>
                  I configured it
                </button>
              </InfoBox>
            )}
            {access.tailscale.serveConfigured && !access.tailscale.funnelConfigured && (
              <button onClick={() => setShowFunnelModal(true)}
                style={{ padding: '8px 16px', borderRadius: 6, background: '#27272a', border: 'none', color: '#f87171', fontSize: 13, fontWeight: 600, alignSelf: 'flex-start' }}>
                Enable Funnel…
              </button>
            )}
            {access.tailscale.funnelConfigured && (
              <InfoBox warning>Funnel is active — this MCP server is publicly reachable on the internet. The dashboard remains inaccessible unless you also enable the toggle below.</InfoBox>
            )}
            {access.tailscale.funnelConfigured && (
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={access.tailscale.allowDashboardOverFunnel}
                  onChange={e => setAccess({ ...access, tailscale: { ...access.tailscale, allowDashboardOverFunnel: e.target.checked } })} />
                Allow dashboard access over Funnel (public internet)
              </label>
            )}
          </div>
        </section>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={access.exposeDashboardExternally}
            onChange={e => setAccess({ ...access, exposeDashboardExternally: e.target.checked })} />
          Expose dashboard externally
        </label>
      </div>

      {error && <p style={{ fontSize: 13, color: '#f87171', marginBottom: 12 }}>{error}</p>}
      <button onClick={() => void handleSave()} disabled={saving}
        style={{ padding: '8px 20px', borderRadius: 6, background: '#2563eb', border: 'none', color: '#fff', fontWeight: 600, fontSize: 14 }}>
        {saving ? 'Saving…' : 'Save'}
      </button>

      {showFunnelModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 12, padding: 24, maxWidth: 440, width: '100%' }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Enable Funnel?</h3>
            <p style={{ fontSize: 13, color: '#a1a1aa', marginBottom: 16, lineHeight: 1.6 }}>
              Funnel exposes this MCP server to the public internet. Tailscale identity no longer limits who can reach the endpoint. Anyone with the URL and a valid MCP API key can connect. The dashboard will remain inaccessible externally unless you also enable <code>allowDashboardOverFunnel</code>.
            </p>
            <p style={{ fontSize: 13, marginBottom: 8 }}>Type <strong style={{ color: '#fbbf24' }}>{FUNNEL_CONFIRM_TEXT}</strong> to confirm:</p>
            <input value={funnelConfirmText} onChange={e => setFunnelConfirmText(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#0f0f0f', color: '#e4e4e7', marginBottom: 16, fontSize: 13 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowFunnelModal(false); setFunnelConfirmText(''); }}
                style={{ padding: '8px 16px', borderRadius: 6, background: 'none', border: '1px solid #3f3f46', color: '#a1a1aa' }}>Cancel</button>
              <button disabled={funnelConfirmText !== FUNNEL_CONFIRM_TEXT} onClick={() => void handleEnableFunnel()}
                style={{ padding: '8px 16px', borderRadius: 6, background: funnelConfirmText === FUNNEL_CONFIRM_TEXT ? '#dc2626' : '#27272a', border: 'none', color: '#fff', fontWeight: 600 }}>
                Enable Funnel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
      <span style={{ color: '#a1a1aa' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function InfoBox({ children, warning }: { children: ReactNode; warning?: boolean }) {
  return (
    <div style={{ padding: '10px 14px', borderRadius: 8, background: '#0f0f0f', border: `1px solid ${warning ? '#ca8a04' : '#27272a'}` }}>
      {children}
    </div>
  );
}
