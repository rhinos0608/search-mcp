import { useState, type FormEvent } from 'react';
import { login, ApiError } from '../api/client.js';

interface Props { onLogin: () => void }

export default function Login({ onLogin }: Props) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [failCount, setFailCount] = useState(0);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await login(key);
      onLogin();
    } catch (err) {
      const count = failCount + 1;
      setFailCount(count);
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Try again in 15 minutes.');
      } else {
        setError(count >= 3 ? `Incorrect key (attempt ${count}). Check stderr logs for the key.` : 'Incorrect API key.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <form onSubmit={handleSubmit} style={{ width: 340, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>search-mcp</h1>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
          MCP API key
          <input
            type="password"
            value={key}
            onChange={e => { setKey(e.target.value); }}
            placeholder="Paste your MCP API key"
            required
            autoFocus
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#18181b', color: '#e4e4e7' }}
          />
        </label>
        {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '10px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', fontWeight: 600 }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
