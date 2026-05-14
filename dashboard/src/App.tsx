import { useState, useEffect } from 'react';
import { checkSetup, checkSession } from './api/client.js';
import Login from './pages/Login.js';
import Setup from './pages/Setup.js';
import Shell from './Shell.js';

type AuthState = 'loading' | 'setup' | 'unauthenticated' | 'authenticated' | 'error';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [setupKey, setSetupKey] = useState('');

  useEffect(() => {
    let mounted = true;
    checkSetup()
      .then(({ claimed, apiKey }) => {
        if (!mounted) return;
        if (!claimed && apiKey) {
          setSetupKey(apiKey);
          setAuth('setup');
        } else {
          return checkSession().then(({ authenticated }) => {
            if (!mounted) return;
            setAuth(authenticated ? 'authenticated' : 'unauthenticated');
          });
        }
      })
      .catch(() => {
        if (!mounted) return;
        setAuth('error');
      });
    return () => { mounted = false; };
  }, []);

  if (auth === 'loading') return <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#a1a1aa' }}>Loading…</div>;
  if (auth === 'error') return <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#f87171' }}>Connection error — check that the server is running.</div>;
  if (auth === 'setup') return <Setup apiKey={setupKey} onClaimed={() => { setAuth('authenticated'); }} />;
  if (auth === 'unauthenticated') return <Login onLogin={() => { setAuth('authenticated'); }} />;
  return <Shell onLogout={() => { setAuth('unauthenticated'); }} />;
}
