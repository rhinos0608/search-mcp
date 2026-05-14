import { useState } from 'react';
import Overview from './pages/Overview.js';
import Providers from './pages/Providers.js';
import Access from './pages/Access.js';

type Page = 'overview' | 'providers' | 'access';

const NAV_ITEMS: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'providers', label: 'Providers' },
  { id: 'access', label: 'Access' },
];

export default function Shell({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>('overview');

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#09090b', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif' }}>
      <nav style={{ width: 200, borderRight: '1px solid #27272a', padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ padding: '0 16px 20px', fontSize: 14, fontWeight: 700, color: '#a1a1aa', letterSpacing: '0.05em' }}>
          search-mcp
        </div>
        {NAV_ITEMS.map(item => (
          <button key={item.id} onClick={() => setPage(item.id)}
            style={{
              padding: '8px 16px', textAlign: 'left', background: page === item.id ? '#18181b' : 'none',
              border: 'none', color: page === item.id ? '#e4e4e7' : '#71717a', fontSize: 14, fontWeight: page === item.id ? 600 : 400,
              borderRadius: 6, margin: '0 8px',
            }}>
            {item.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={onLogout}
          style={{ margin: '0 8px', padding: '8px 16px', textAlign: 'left', background: 'none', border: 'none', color: '#71717a', fontSize: 14, borderRadius: 6 }}>
          Log out
        </button>
      </nav>
      <main style={{ flex: 1, overflowY: 'auto' }}>
        {page === 'overview' && <Overview onLogout={onLogout} />}
        {page === 'providers' && <Providers />}
        {page === 'access' && <Access />}
      </main>
    </div>
  );
}
