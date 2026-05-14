import { useState, useEffect } from 'react';
import { getConfigStatus, updateConfig, testConnection } from '../api/client.js';

interface FieldState {
  current: string;  // "•••" for configured, "" for unconfigured
  edit: string;     // what user typed; "" = keep
  dirty: boolean;
}

function MaskedField({ label, fieldKey, state, onChange }: {
  label: string;
  fieldKey: string;
  state: FieldState;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      {label}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="password"
          value={state.edit}
          placeholder={state.current === '•••' ? '•••  (unchanged)' : 'Not set'}
          onChange={e => onChange(fieldKey, e.target.value)}
          style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #3f3f46', background: '#0f0f0f', color: '#e4e4e7', fontSize: 13 }}
        />
        {state.current === '•••' && (
          <button onClick={() => onChange(fieldKey, '\x00CLEAR')} title="Clear this field"
            style={{ padding: '6px 10px', borderRadius: 6, background: '#27272a', border: 'none', color: '#f87171', fontSize: 12 }}>
            Clear
          </button>
        )}
      </div>
    </label>
  );
}

const PROVIDER_GROUPS = [
  { id: 'brave', label: 'Brave Search', fields: [{ key: 'apiKey', label: 'API Key' }] },
  { id: 'searxng', label: 'SearXNG', fields: [{ key: 'baseUrl', label: 'Base URL' }] },
  { id: 'exa', label: 'Exa', fields: [{ key: 'apiKey', label: 'API Key' }] },
  { id: 'crawl4ai', label: 'Crawl4AI', fields: [{ key: 'baseUrl', label: 'Base URL' }, { key: 'apiToken', label: 'API Token' }] },
  { id: 'youtube', label: 'YouTube', fields: [{ key: 'apiKey', label: 'API Key' }] },
  { id: 'github', label: 'GitHub', fields: [{ key: 'token', label: 'Token' }] },
];

/** Pure helper: given previous fields state, return updated fields for a change event. */
function updateFieldState(
  prev: Record<string, Record<string, FieldState>>,
  groupId: string,
  fieldKey: string,
  value: string,
): Record<string, Record<string, FieldState>> {
  return {
    ...prev,
    [groupId]: {
      ...prev[groupId],
      [fieldKey]: {
        ...(prev[groupId]?.[fieldKey] ?? { current: '', edit: '', dirty: false }),
        edit: value,
        dirty: true,
      },
    },
  };
}

export default function Providers() {
  const [fields, setFields] = useState<Record<string, Record<string, FieldState>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    getConfigStatus().then(({ config: _raw }) => {
      const raw = _raw as Record<string, Record<string, string>>;
      const init: typeof fields = {};
      for (const g of PROVIDER_GROUPS) {
        const group: Record<string, FieldState> = {};
        init[g.id] = group;
        for (const f of g.fields) {
          const current = raw[g.id]?.[f.key] ?? '';
          group[f.key] = { current, edit: '', dirty: false };
        }
      }
      setFields(init);
      setLoadError(null);
    }).catch((err) => {
      setLoadError(String(err));
    });
  }, []);

  function handleChange(groupId: string, fieldKey: string, value: string) {
    setFields(prev => updateFieldState(prev, groupId, fieldKey, value));
  }

  async function handleSave(groupId: string) {
    setSaving(groupId);
    setSaveErrors(prev => { const next = { ...prev }; delete next[groupId]; return next; });
    const groupFields = fields[groupId] ?? {};
    const patch: Record<string, { op: 'keep' | 'clear' | 'set'; value?: string }> = {};
    for (const [key, state] of Object.entries(groupFields)) {
      if (!state.dirty) { patch[key] = { op: 'keep' }; continue; }
      if (state.edit === '\x00CLEAR') { patch[key] = { op: 'clear' }; continue; }
      if (state.edit === '') { patch[key] = { op: 'keep' }; continue; }
      patch[key] = { op: 'set', value: state.edit };
    }
    try {
      await updateConfig({ [groupId]: patch });
      // Reset dirty state
      setFields(prev => {
        const updated = { ...prev[groupId] };
        for (const key of Object.keys(updated)) {
          const field = updated[key];
          if (field) updated[key] = { ...field, edit: '', dirty: false };
        }
        return { ...prev, [groupId]: updated };
      });
    } catch (err) {
      setSaveErrors(prev => ({ ...prev, [groupId]: String(err) }));
    } finally {
      setSaving(null);
    }
  }

  async function handleTest(providerId: string) {
    const result = await testConnection(providerId).catch(err => ({ ok: false, error: String(err) }));
    setTestResults(prev => ({ ...prev, [providerId]: result }));
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>Providers</h1>
      {loadError && (
        <div style={{ background: '#451a1a', border: '1px solid #dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: '#f87171', margin: 0 }}>Failed to load config: {loadError}</p>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {PROVIDER_GROUPS.map(group => (
          <div key={group.id} style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>{group.label}</h2>
              <button onClick={() => void handleTest(group.id)}
                style={{ fontSize: 12, padding: '4px 10px', borderRadius: 5, background: '#27272a', border: 'none', color: '#a1a1aa' }}>
                Test connection
              </button>
            </div>
            {testResults[group.id] && (
              <p style={{ fontSize: 12, marginBottom: 12, color: testResults[group.id]?.ok ? '#86efac' : '#f87171' }}>
                {testResults[group.id]?.ok
                  ? `✓ Connected (${testResults[group.id]?.latencyMs ?? '?'}ms)`
                  : `✗ ${testResults[group.id]?.error ?? 'Error'}`}
              </p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {group.fields.map(f => (
                <MaskedField
                  key={f.key}
                  label={f.label}
                  fieldKey={f.key}
                  state={fields[group.id]?.[f.key] ?? { current: '', edit: '', dirty: false }}
                  onChange={(k, v) => handleChange(group.id, k, v)}
                />
              ))}
            </div>
            {saveErrors[group.id] && <p style={{ fontSize: 12, color: '#f87171', marginBottom: 8 }}>{saveErrors[group.id]}</p>}
            <button onClick={() => void handleSave(group.id)} disabled={saving === group.id}
              style={{ padding: '7px 16px', borderRadius: 6, background: '#2563eb', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600 }}>
              {saving === group.id ? 'Saving…' : 'Save'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
