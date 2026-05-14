import { useState, useEffect, useRef } from 'react';
import { claimKey } from '../api/client.js';

export default function Setup({ apiKey, onClaimed }: { apiKey: string; onClaimed: () => void }) {
  const [copied, setCopied] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState('');
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Failed to copy to clipboard');
    }
  }

  async function handleClaim() {
    setClaiming(true);
    setError('');
    try {
      await claimKey();
      onClaimed();
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : typeof e === 'object' && e !== null && 'message' in e
            ? String((e as Record<string, unknown>).message)
            : 'Claim failed. Check that the server is running and SEARCH_MCP_CONFIG_KEY is set.';
      setError(message);
      console.error('Claim error:', e);
      setClaiming(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ maxWidth: 480, width: '100%', padding: 32, background: '#18181b', borderRadius: 12, border: '1px solid #27272a' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Your MCP API Key</h1>
        <p style={{ fontSize: 14, color: '#a1a1aa', marginBottom: 24, lineHeight: 1.6 }}>
          Copy this key now — it will not be shown again. You will use it to log into this dashboard and as the Bearer token for MCP clients.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <code style={{ flex: 1, padding: '10px 14px', background: '#0f0f0f', borderRadius: 8, fontSize: 13, color: '#60a5fa', wordBreak: 'break-all', border: '1px solid #27272a' }}>
            {apiKey}
          </code>
          <button
            onClick={() => void handleCopy()}
            style={{ padding: '10px 14px', borderRadius: 8, background: copied ? '#14532d' : '#27272a', border: 'none', color: copied ? '#86efac' : '#e4e4e7', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer' }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        <div style={{ background: '#1c1917', border: '1px solid #ca8a04', borderRadius: 8, padding: '10px 14px', marginBottom: 24 }}>
          <p style={{ fontSize: 13, color: '#fbbf24', margin: 0, lineHeight: 1.5 }}>
            Store this key securely. Once you continue, this screen will not appear again.
          </p>
        </div>

        {error && <p style={{ fontSize: 13, color: '#f87171', marginBottom: 12 }}>{error}</p>}

        <button
          onClick={() => void handleClaim()}
          disabled={claiming}
          style={{ width: '100%', padding: '10px 16px', borderRadius: 8, background: '#2563eb', border: 'none', color: '#fff', fontSize: 14, fontWeight: 600, cursor: claiming ? 'not-allowed' : 'pointer', opacity: claiming ? 0.7 : 1 }}>
          {claiming ? 'Continuing…' : "I've saved my key — continue"}
        </button>
      </div>
    </div>
  );
}
