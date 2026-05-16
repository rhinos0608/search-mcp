import { useState, useEffect } from 'react';
import {
  getProviders,
  getConnectionInfo,
  getTailscaleStatus,
  rotateApiKey,
  logout,
} from '../api/client.js';
import type { TailscaleStatusInfo } from '../api/client.js';

interface Props { onLogout: () => void }

interface ConnInfo {
  mcpUrl: string;
  apiKey: string;
  allowQueryKey: boolean;
  localPort: number;
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

function copyToClipboard(text: string, key: string, setCopied: (k: string | null) => void) {
  void navigator.clipboard.writeText(text).then(() => {
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  });
}

/** Make an MCP client config snippet. mode: 'http' | 'stdio-local' | 'stdio-remote' */
function makeSnippet(mode: 'http' | 'stdio-local' | 'stdio-remote', info: ConnInfo, tailscaleHost?: string | null): string {
  if (mode === 'http') {
    const url = tailscaleHost
      ? `https://${tailscaleHost}/mcp`
      : info.mcpUrl;
    return JSON.stringify({
      mcpServers: {
        'search-mcp': {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${info.apiKey}` },
        },
      },
    }, null, 2);
  }
  if (mode === 'stdio-local') {
    return JSON.stringify({
      mcpServers: {
        'search-mcp': {
          command: 'npx',
          args: ['-y', 'search-mcp'],
          env: {
            BRAVE_API_KEY: 'your_brave_key',
          },
        },
      },
    }, null, 2);
  }
  // stdio-remote (mcp-remote)
  const url = tailscaleHost
    ? `https://${tailscaleHost}/mcp`
    : info.mcpUrl;
  return JSON.stringify({
    mcpServers: {
      'search-mcp': {
        command: 'npx',
        args: [
          '-y', 'mcp-remote',
          url,
          '--header', `Authorization: Bearer ${info.apiKey}`,
        ],
      },
    },
  }, null, 2);
}

export default function Overview({ onLogout }: Props) {
  const [providers, setProviders] = useState<{ id: string; configured: boolean }[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [connInfo, setConnInfo] = useState<ConnInfo | null>(null);
  const [tsStatus, setTsStatus] = useState<TailscaleStatusInfo | null>(null);
  const [showRotateModal, setShowRotateModal] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [snippetTab, setSnippetTab] = useState<'http' | 'stdio-local' | 'stdio-remote'>('http');

  useEffect(() => {
    let mounted = true;

    Promise.all([
      getProviders(),
      getConnectionInfo(),
      getTailscaleStatus(),
    ]).then(([provRes, connRes, tsRes]) => {
      if (!mounted) return;
      setProviders(provRes.providers);
      setProvidersError(null);
      setConnInfo({
        mcpUrl: connRes.mcpUrl,
        apiKey: connRes.apiKey,
        allowQueryKey: connRes.allowQueryKey,
        localPort: connRes.localPort,
      });
      setTsStatus(tsRes.tailscale);
    }).catch(() => {
      if (mounted) {
        setProviders([]);
        setProvidersError('Failed to load. Is the server running?');
      }
    });

    return () => { mounted = false; };
  }, []);

  async function handleRotate() {
    setRotating(true);
    try {
      const result = await rotateApiKey();
      setNewKey(result.newKey);
      setShowRotateModal(false);
    } catch (e) {
      console.error('Rotation failed', e);
    } finally {
      setRotating(false);
    }
  }

  async function handleLogout() {
    await logout().catch(() => {});
    onLogout();
  }

  // ── derived values ──
  const quickConnectUrl = connInfo?.allowQueryKey
    ? `${connInfo.mcpUrl}?key=${connInfo.apiKey}`
    : null;

  const tailscaleHost = tsStatus?.magicDnsName || null;
  const tailscaleQuickUrl = tailscaleHost && connInfo?.allowQueryKey
    ? `https://${tailscaleHost}/mcp?key=${connInfo.apiKey}`
    : null;

  const httpSnippet = connInfo ? makeSnippet('http', connInfo, tailscaleHost) : '';
  const stdioLocalSnippet = connInfo ? makeSnippet('stdio-local', connInfo) : '';
  const stdioRemoteSnippet = connInfo ? makeSnippet('stdio-remote', connInfo, tailscaleHost) : '';

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>search-mcp dashboard</h1>
        <button onClick={() => { void handleLogout(); }} style={{ background: 'none', border: '1px solid #3f3f46', color: '#a1a1aa', padding: '6px 12px', borderRadius: 6 }}>Log out</button>
      </div>

      {/* ── Quick Connect URL (Tavily-style) ── */}
      {quickConnectUrl && (
        <section style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Quick Connect URL</h2>
          <p style={{ fontSize: 12, color: '#71717a', marginBottom: 10 }}>
            Paste this URL into any MCP client that supports query-param auth. Your API key is embedded — keep it private.
          </p>
          <CodeBlock text={quickConnectUrl} onCopy={() => copyToClipboard(quickConnectUrl, 'quick', setCopied)} copied={copied === 'quick'} />
        </section>
      )}

      {/* ── Tailscale Quick Connect ── */}
      {tailscaleQuickUrl && (
        <section style={{ background: '#0f1a1a', borderRadius: 10, border: '1px solid #164e63', padding: 20, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#22d3ee', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tailscale Quick Connect</h2>
          <p style={{ fontSize: 12, color: '#67e8f9', marginBottom: 10 }}>
            Connect from any device on your tailnet. Your API key is embedded in the URL.
          </p>
          <CodeBlock text={tailscaleQuickUrl} onCopy={() => copyToClipboard(tailscaleQuickUrl, 'ts-quick', setCopied)} copied={copied === 'ts-quick'} />
        </section>
      )}

      {/* ── Client Config Snippets ── */}
      <section style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Client Config</h2>
        <p style={{ fontSize: 12, color: '#71717a', marginBottom: 10 }}>
          Copy this into your MCP client's config file ({' '}
          <code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>claude_desktop_config.json</code>,{' '}
          <code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>~/.cursor/mcp.json</code>, etc.).
        </p>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {([
            ['http', 'HTTP (SSE)'],
            ['stdio-local', 'Stdio (npx)'],
            ['stdio-remote', tailscaleHost ? 'Tailscale (mcp-remote)' : 'Remote (mcp-remote)'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSnippetTab(id)}
              style={{
                padding: '5px 12px', borderRadius: 5, border: 'none',
                background: snippetTab === id ? '#2563eb' : '#27272a',
                color: snippetTab === id ? '#fff' : '#a1a1aa',
                fontSize: 12, fontWeight: snippetTab === id ? 600 : 400,
                cursor: 'pointer',
              }}>
              {label}
            </button>
          ))}
        </div>

        {snippetTab === 'http' && connInfo && (
          <CodeBlock text={httpSnippet} onCopy={() => copyToClipboard(httpSnippet, 'http', setCopied)} copied={copied === 'http'} mono />
        )}
        {snippetTab === 'stdio-local' && connInfo && (
          <>
            <CodeBlock text={stdioLocalSnippet} onCopy={() => copyToClipboard(stdioLocalSnippet, 'local', setCopied)} copied={copied === 'local'} mono />
            <p style={{ fontSize: 11, color: '#71717a', marginTop: 6 }}>
              Requires <code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>npm install -g search-mcp</code>.
              Add your API keys to the <code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>env</code> block.
            </p>
          </>
        )}
        {snippetTab === 'stdio-remote' && connInfo && (
          <>
            <CodeBlock text={stdioRemoteSnippet} onCopy={() => copyToClipboard(stdioRemoteSnippet, 'remote', setCopied)} copied={copied === 'remote'} mono />
            <p style={{ fontSize: 11, color: '#71717a', marginTop: 6 }}>
              Uses{' '}
              <a href="https://github.com/geelen/mcp-remote" target="_blank" rel="noopener" style={{ color: '#60a5fa' }}>mcp-remote</a>
              {' '}to bridge stdio → HTTP.{' '}
              <code style={{ background: '#1c1c1f', padding: '1px 4px', borderRadius: 3 }}>npx -y mcp-remote</code> auto-installs it.
            </p>
          </>
        )}
      </section>

      {/* ── Providers Summary ── */}
      <section style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Providers</h2>
        {providersError && <p style={{ fontSize: 13, color: '#f87171', marginBottom: 12 }}>{providersError}</p>}
        {!providersError && providers.length === 0 && <p style={{ fontSize: 13, color: '#71717a' }}>No providers configured.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
          {providers.map(p => (
            <div key={p.id} style={{ padding: '10px 14px', background: '#0f0f0f', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>{p.id}</span>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: p.configured ? '#14532d' : '#27272a', color: p.configured ? '#86efac' : '#71717a' }}>
                {p.configured ? 'ok' : 'not set'}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── API Key Rotation ── */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>API Key</h2>
        {newKey ? (
          <div style={{ padding: 16, background: '#18181b', borderRadius: 8, border: '1px solid #ca8a04' }}>
            <p style={{ fontSize: 13, marginBottom: 8, color: '#fbbf24' }}>New API key — copy it now. It will not be shown again.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <code style={{ flex: 1, padding: '8px 12px', background: '#0f0f0f', borderRadius: 6, fontSize: 13, wordBreak: 'break-all' }}>{newKey}</code>
              <button onClick={() => { void navigator.clipboard.writeText(newKey); }}
                style={{ padding: '8px 12px', borderRadius: 6, background: '#27272a', border: 'none', color: '#e4e4e7', fontSize: 13 }}>Copy</button>
            </div>
            <p style={{ fontSize: 12, color: '#71717a', marginTop: 8 }}>All existing MCP sessions have been terminated. Your dashboard session is now invalid.</p>
            <button onClick={() => void handleLogout()}
              style={{ marginTop: 10, padding: '6px 14px', borderRadius: 5, background: '#27272a', border: 'none', color: '#60a5fa', fontSize: 13, cursor: 'pointer' }}>
              Log in with new key →
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setShowRotateModal(true); }}
            style={{ padding: '8px 16px', borderRadius: 6, background: '#27272a', border: 'none', color: '#f87171', fontSize: 13, fontWeight: 600 }}
          >
            Rotate API key…
          </button>
        )}
      </section>

      {showRotateModal && !newKey && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%' }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Rotate API key?</h3>
            <p style={{ fontSize: 13, color: '#a1a1aa', marginBottom: 20, lineHeight: 1.6 }}>
              This will generate a new API key and immediately terminate all active MCP connections and dashboard sessions. You will need to update any configured MCP clients.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowRotateModal(false); }} style={{ padding: '8px 16px', borderRadius: 6, background: 'none', border: '1px solid #3f3f46', color: '#a1a1aa' }}>Cancel</button>
              <button onClick={() => { void handleRotate(); }} disabled={rotating}
                style={{ padding: '8px 16px', borderRadius: 6, background: '#dc2626', border: 'none', color: '#fff', fontWeight: 600 }}>
                {rotating ? 'Rotating…' : 'Rotate key'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
