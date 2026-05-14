import { useState, useEffect } from 'react';
import { checkSession } from './api/client.js';
import Login from './pages/Login.js';
import Overview from './pages/Overview.js';

type AuthState = 'loading' | 'unauthenticated' | 'authenticated';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');

  useEffect(() => {
    checkSession()
      .then(({ authenticated }) => { setAuth(authenticated ? 'authenticated' : 'unauthenticated'); })
      .catch(() => { setAuth('unauthenticated'); });
  }, []);

  if (auth === 'loading') return <div style={{ padding: 24 }}>Loading…</div>;
  if (auth === 'unauthenticated') return <Login onLogin={() => { setAuth('authenticated'); }} />;
  return <Overview onLogout={() => { setAuth('unauthenticated'); }} />;
}
