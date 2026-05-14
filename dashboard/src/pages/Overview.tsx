import { useState, useEffect } from 'react';
import { getProviders, rotateApiKey, logout } from '../api/client.js';

interface Props { onLogout: () => void }

export default function Overview({ onLogout }: Props) {
  const [providers, setProviders] = useState<{ id: string; configured: boolean }[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [showRotateModal, setShowRotateModal] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [rotating, setRotating] = useState(false);
  const [mcpUrl] = useState(`${window.location.origin}/mcp`);

  useEffect(() => {
    let mounted = true;
    getProviders()
      .then(r => { if (mounted) { setProviders(r.providers); setProvidersError(null); } })
      .catch(() => { if (mounted) { setProviders([]); setProvidersError('Failed to load providers. Is the server running?'); } });
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

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>search-mcp dashboard</h1>
        <button onClick={() => { void handleLogout(); }} style={{ background: 'none', border: '1px solid #3f3f46', color: '#a1a1aa', padding: '6px 12px', borderRadius: 6 }}>Log out</button>
      </div>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>MCP Connection URL</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code style={{ flex: 1, padding: '8px 12px', background: '#18181b', borderRadius: 6, fontSize: 13, color: '#60a5fa' }}>
            {mcpUrl}
          </code>
          <button onClick={() => { void navigator.clipboard.writeText(mcpUrl); }}
            style={{ padding: '8px 12px', borderRadius: 6, background: '#27272a', border: 'none', color: '#e4e4e7', fontSize: 13 }}>
            Copy
          </button>
        </div>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Providers</h2>
        {providersError && <p style={{ fontSize: 13, color: '#f87171', marginBottom: 12 }}>{providersError}</p>}
        {!providersError && providers.length === 0 && <p style={{ fontSize: 13, color: '#71717a' }}>No providers configured.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
          {providers.map(p => (
            <div key={p.id} style={{ padding: '10px 14px', background: '#18181b', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>{p.id}</span>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: p.configured ? '#14532d' : '#27272a', color: p.configured ? '#86efac' : '#71717a' }}>
                {p.configured ? 'ok' : 'not set'}
              </span>
            </div>
          ))}
        </div>
      </section>

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
