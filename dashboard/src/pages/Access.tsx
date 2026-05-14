import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { getAccess, updateAccess, getConnectionInfo, getTailscaleStatus } from '../api/client.js';
import type { AccessConfig, TailscaleStatusInfo } from '../api/client.js';

const FUNNEL_CONFIRM_TEXT = 'enable funnel';

interface ConnInfo {
  localPort: number;
  apiKey: string;
  allowQueryKey: boolean;
}

function tailscaleServiceHost(magicDnsName: string): string | null {
  // magicDnsName = "my-machine.tailnet-xyz.ts.net"
  // service host  = "svc-mcp-server.tailnet-xyz.ts.net"
  const dot = magicDnsName.indexOf('.');
  if (dot === -1) return null;
  return `svc-mcp-server${magicDnsName.slice(dot)}`;
}

export default function Access() {
  const [access, setAccess] = useState<AccessConfig | null>(null);
  const [connInfo, setConnInfo] = useState<ConnInfo | null>(null);
  const [tsStatus, setTsStatus] = useState<TailscaleStatusInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [showFunnelModal, setShowFunnelModal] = useState(false);
  const [funnelConfirmText, setFunnelConfirmText] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      getAccess(),
      getConnectionInfo(),
      getTailscaleStatus(),
    ]).then(([accessRes, connRes, tsRes]) => {
      setAccess(accessRes.access);
      setManualUrl(accessRes.access.manualBaseUrl ?? '');
      setConnInfo({ localPort: connRes.localPort, apiKey: connRes.apiKey, allowQueryKey: connRes.allowQueryKey });
      setTsStatus(tsRes.tailscale);
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

  async function handleMarkServeConfigured() {
    if (!access) return;
    try {
      await updateAccess({ ...access, tailscale: { ...access.tailscale, serveConfigured: true } });
      const r = await getAccess();
      setAccess(r.access);
    } catch (e) { setError(String(e)); }
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

  function copyText(text: string, key: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  if (!access) return <div style={{ padding: 24 }}>Loading…</div>;

  const serviceHost = tsStatus?.magicDnsName ? tailscaleServiceHost(tsStatus.magicDnsName) : null;
  const serveCmd = connInfo
    ? `tailscale serve --service=svc:mcp-server --https=443 http://localhost:${String(connInfo.localPort)}`
    : 'tailscale serve --service=svc:mcp-server --https=443 http://localhost:<port>';

  const connectionUrl = serviceHost
    ? `https://${serviceHost}/mcp${connInfo?.allowQueryKey ? `?key=${connInfo.apiKey}` : ''}`
    : null;

  const mcpRemoteSnippet = serviceHost
    ? JSON.stringify(
        {
          mcpServers: {
            'search-mcp': {
              command: 'npx',
              args: [
                'mcp-remote',
                `https://${serviceHost}/mcp`,
                '--header',
                `Authorization: Bearer ${connInfo?.apiKey ?? '<api-key>'}`,
              ],
            },
          },
        },
        null,
        2,
      )
    : JSON.stringify(
        {
          mcpServers: {
            'search-mcp': {
              command: 'npx',
              args: [
                'mcp-remote',
                'https://svc-mcp-server.<tailnet>.ts.net/mcp',
                '--header',
                'Authorization: Bearer <api-key>',
              ],
            },
          },
        },
        null,
        2,
      );

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
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Tailscale Serve</h2>

          {!access.tailscale.serveConfigured ? (
            <InfoBox>
              <p style={{ fontSize: 13, marginBottom: 8 }}>
                Run this command to expose the MCP server over Tailscale HTTPS. This creates a named service at
                {' '}<code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3, fontSize: 11 }}>svc-mcp-server.&lt;tailnet&gt;.ts.net</code>:
              </p>
              <CodeBlock text={serveCmd} onCopy={() => copyText(serveCmd, 'serve')} copied={copied === 'serve'} />
              <p style={{ fontSize: 12, color: '#71717a', marginTop: 8 }}>
                Verify with: <code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>tailscale serve status</code>
              </p>
              <button
                onClick={() => void handleMarkServeConfigured()}
                style={{ marginTop: 12, padding: '6px 14px', borderRadius: 5, background: '#27272a', border: 'none', color: '#60a5fa', fontSize: 13, cursor: 'pointer' }}>
                I configured it
              </button>
            </InfoBox>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#4ade80' }}>
                <span>✓</span>
                <span>Serve configured</span>
                {tsStatus?.serveActive === true && <span style={{ color: '#71717a' }}>· active</span>}
              </div>

              <InfoBox>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Connection URL</p>
                {connectionUrl ? (
                  <>
                    <CodeBlock text={connectionUrl} onCopy={() => copyText(connectionUrl, 'url')} copied={copied === 'url'} />
                    {!connInfo?.allowQueryKey && (
                      <p style={{ fontSize: 12, color: '#71717a', marginTop: 6 }}>
                        Query-param auth is disabled. Use <code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>Authorization: Bearer {connInfo?.apiKey ?? '…'}</code>
                      </p>
                    )}
                  </>
                ) : (
                  <p style={{ fontSize: 12, color: '#71717a' }}>
                    Tailscale not detected locally. Your URL:
                    {' '}<code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>https://svc-mcp-server.&lt;tailnet&gt;.ts.net/mcp</code>
                  </p>
                )}
              </InfoBox>

              <InfoBox>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  For stdio-only clients (mcp-remote)
                </p>
                <p style={{ fontSize: 12, color: '#71717a', marginBottom: 8 }}>
                  Add to your Claude Desktop / MCP client config:
                </p>
                <CodeBlock text={mcpRemoteSnippet} onCopy={() => copyText(mcpRemoteSnippet, 'snippet')} copied={copied === 'snippet'} mono />
              </InfoBox>

              <button
                onClick={() => {
                  setAccess({ ...access, tailscale: { ...access.tailscale, serveConfigured: false } });
                }}
                style={{ padding: '5px 12px', borderRadius: 5, background: 'none', border: '1px solid #3f3f46', color: '#71717a', fontSize: 12, alignSelf: 'flex-start', cursor: 'pointer' }}>
                Reset serve configuration
              </button>
            </div>
          )}

          {/* Advanced: Funnel */}
          <details style={{ marginTop: 20 }}>
            <summary style={{ fontSize: 13, color: '#71717a', cursor: 'pointer', userSelect: 'none' }}>
              Advanced: Public Funnel
            </summary>
            <div style={{ marginTop: 12 }}>
              <InfoBox warning>
                <p style={{ fontSize: 13, marginBottom: 8 }}>
                  <strong>Not recommended for normal use.</strong> Funnel exposes this server to the public internet — anyone with the URL can attempt to connect. Tailscale identity no longer limits who can reach the endpoint.
                </p>
                <p style={{ fontSize: 12, color: '#71717a' }}>
                  Only enable Funnel if you need clients outside your tailnet to connect and cannot use mcp-remote as a proxy.
                </p>
              </InfoBox>
              {!access.tailscale.funnelConfigured ? (
                <button
                  onClick={() => setShowFunnelModal(true)}
                  style={{ marginTop: 10, padding: '6px 14px', borderRadius: 5, background: '#27272a', border: '1px solid #dc2626', color: '#f87171', fontSize: 13, cursor: 'pointer' }}>
                  Enable Funnel…
                </button>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: '#f87171', marginTop: 10 }}>✓ Funnel active — MCP endpoint is publicly reachable</p>
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, marginTop: 10 }}>
                    <input type="checkbox" checked={access.tailscale.allowDashboardOverFunnel}
                      onChange={e => setAccess({ ...access, tailscale: { ...access.tailscale, allowDashboardOverFunnel: e.target.checked } })} />
                    Allow dashboard access over Funnel (public internet)
                  </label>
                </>
              )}
            </div>
          </details>
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
        style={{ padding: '8px 20px', borderRadius: 6, background: '#2563eb', border: 'none', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
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
                style={{ padding: '8px 16px', borderRadius: 6, background: 'none', border: '1px solid #3f3f46', color: '#a1a1aa', cursor: 'pointer' }}>Cancel</button>
              <button disabled={funnelConfirmText !== FUNNEL_CONFIRM_TEXT} onClick={() => void handleEnableFunnel()}
                style={{ padding: '8px 16px', borderRadius: 6, background: funnelConfirmText === FUNNEL_CONFIRM_TEXT ? '#dc2626' : '#27272a', border: 'none', color: '#fff', fontWeight: 600, cursor: funnelConfirmText === FUNNEL_CONFIRM_TEXT ? 'pointer' : 'default' }}>
                Enable Funnel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CodeBlock({ text, onCopy, copied, mono }: { text: string; onCopy: () => void; copied: boolean; mono?: boolean }) {
  return (
    <div style={{ position: 'relative' }}>
      <pre style={{
        margin: 0,
        padding: '10px 12px',
        background: '#0f0f0f',
        borderRadius: 6,
        fontSize: mono ? 11 : 12,
        fontFamily: 'monospace',
        color: '#e4e4e7',
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        paddingRight: 60,
      }}>
        {text}
      </pre>
      <button
        onClick={onCopy}
        style={{
          position: 'absolute', top: 6, right: 6,
          padding: '3px 8px', borderRadius: 4,
          background: '#27272a', border: 'none',
          color: copied ? '#4ade80' : '#a1a1aa',
          fontSize: 11, cursor: 'pointer',
        }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
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
