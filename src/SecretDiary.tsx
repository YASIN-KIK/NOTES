import { useEffect, useState } from 'react';
import './App.css';

type Entry = { id: string; date: string; content: string; mood: string; createdAt: number };

const STORAGE_KEY = 'secret-diary:entries';

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function loadEntries(): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

const MOODS = ['😊', '😐', '😢', '😡', '😴', '🤔', '😍', '😰'];

export default function SecretDiary() {
  const [entries, setEntries] = useState<Entry[]>(() => loadEntries());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(() => localStorage.getItem('secret-diary:unlocked') === '1');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [hasPassword, setHasPassword] = useState(() => !!localStorage.getItem('secret-diary:hash'));
  const [showChange, setShowChange] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [changeError, setChangeError] = useState('');
  const [changeDone, setChangeDone] = useState(false);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }, [entries]);

  const hashPw = async (pw: string) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const setupPassword = async () => {
    if (!password) { setError('Password required'); return; }
    const h = await hashPw(password);
    localStorage.setItem('secret-diary:hash', h);
    setHasPassword(true);
    setUnlocked(true);
    localStorage.setItem('secret-diary:unlocked', '1');
    setPassword(''); setError('');
  };

  const tryUnlock = async () => {
    const h = await hashPw(password);
    if (h === localStorage.getItem('secret-diary:hash')) {
      setUnlocked(true);
      localStorage.setItem('secret-diary:unlocked', '1');
      setPassword(''); setError('');
    } else { setError('Wrong password'); }
  };

  const lock = () => { setUnlocked(false); localStorage.removeItem('secret-diary:unlocked'); };

  const changePassword = async () => {
    setChangeError(''); setChangeDone(false);
    if (!currentPw) { setChangeError('Enter your current password'); return; }
    if (await hashPw(currentPw) !== localStorage.getItem('secret-diary:hash')) {
      setChangeError('Current password is wrong'); return;
    }
    if (!newPw) { setChangeError('Enter a new password'); return; }
    if (newPw !== confirmPw) { setChangeError('New passwords do not match'); return; }
    localStorage.setItem('secret-diary:hash', await hashPw(newPw));
    setCurrentPw(''); setNewPw(''); setConfirmPw('');
    setShowChange(false); setChangeDone(true);
  };

  const selected = entries.find((e) => e.id === selectedId) || null;

  const createEntry = () => {
    const today = new Date().toISOString().slice(0, 10);
    const e: Entry = { id: uid(), date: today, content: '', mood: '😐', createdAt: Date.now() };
    setEntries((prev) => [e, ...prev]);
    setSelectedId(e.id);
  };

  const updateEntry = (id: string, patch: Partial<Entry>) => {
    setEntries((prev) => prev.map((e) => e.id === id ? { ...e, ...patch } : e));
  };

  const deleteEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  if (!hasPassword) {
    return (
      <div className="app" style={{ background: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)', color: '#e0e0ff' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'rgba(255,255,255,0.05)', padding: 32, borderRadius: 16, width: 360, backdropFilter: 'blur(10px)' }}>
            <h2 style={{ textAlign: 'center', marginBottom: 8 }}>🌙 Secret Diary</h2>
            <p style={{ textAlign: 'center', color: '#a0a0cc', fontSize: 13, marginBottom: 16 }}>Set a password to protect your private entries.</p>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create password" style={{ width: '100%', padding: 10, border: '1px solid #4a4a7a', borderRadius: 8, background: 'rgba(0,0,0,0.3)', color: '#e0e0ff', marginBottom: 8 }} />
            {error && <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 8 }}>{error}</div>}
            <button onClick={setupPassword} style={{ width: '100%', padding: 10, background: '#7c4dff', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>Set password & enter</button>
          </div>
        </div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="app" style={{ background: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)', color: '#e0e0ff' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'rgba(255,255,255,0.05)', padding: 32, borderRadius: 16, width: 360, backdropFilter: 'blur(10px)' }}>
            <h2 style={{ textAlign: 'center', marginBottom: 8 }}>🌙 Secret Diary</h2>
            <p style={{ textAlign: 'center', color: '#a0a0cc', fontSize: 13, marginBottom: 16 }}>Enter your password to unlock.</p>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && tryUnlock()} placeholder="Password" style={{ width: '100%', padding: 10, border: '1px solid #4a4a7a', borderRadius: 8, background: 'rgba(0,0,0,0.3)', color: '#e0e0ff', marginBottom: 8 }} />
            {error && <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 8 }}>{error}</div>}
            <button onClick={tryUnlock} style={{ width: '100%', padding: 10, background: '#7c4dff', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>Unlock</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app" style={{ background: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)', color: '#e0e0ff' }}>
      <aside className="sidebar" style={{ background: 'rgba(255,255,255,0.03)', borderRight: '1px solid #4a4a7a' }}>
        <div className="sidebar-header">
          <h1 style={{ color: '#c0c0ff' }}>🌙 Diary</h1>
          <button className="icon-btn" onClick={() => { setShowChange(true); setChangeDone(false); setChangeError(''); }} title="Change password" style={{ color: '#c0c0ff', fontSize: 13 }}>🔑</button>
          <button className="icon-btn" onClick={lock} title="Lock" style={{ color: '#c0c0ff' }}>🔒</button>
        </div>
        <button className="primary-btn" style={{ background: '#7c4dff' }} onClick={createEntry}>+ New Entry</button>
        <ul className="note-list">
          {entries.length === 0 && <li className="empty" style={{ color: '#a0a0cc' }}>No entries yet</li>}
          {entries.map((e) => (
            <li key={e.id} className={e.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(e.id)} style={{ borderLeft: '3px solid #7c4dff' }}>
              <div className="note-row">
                <span className="note-title" style={{ color: '#e0e0ff' }}>{e.mood} {e.date}</span>
              </div>
              <div className="note-preview" style={{ color: '#a0a0cc' }}>{e.content.slice(0, 60) || 'Empty entry'}</div>
            </li>
          ))}
        </ul>
      </aside>
      <main className="editor" style={{ background: 'transparent' }}>
        {selected ? (
          <>
            <div className="editor-header">
              <input className="title-input" style={{ color: '#e0e0ff' }} type="date" value={selected.date} onChange={(e) => updateEntry(selected.id, { date: e.target.value })} />
              <div className="editor-actions">
                <div style={{ display: 'flex', gap: 4 }}>
                  {MOODS.map((m) => (
                    <button key={m} onClick={() => updateEntry(selected.id, { mood: m })} style={{ background: selected.mood === m ? '#7c4dff' : 'transparent', border: '1px solid #4a4a7a', borderRadius: 6, padding: '2px 6px', cursor: 'pointer', fontSize: 16 }}>{m}</button>
                  ))}
                </div>
                <button className="danger" onClick={() => deleteEntry(selected.id)} style={{ color: '#ff6b6b', border: '1px solid #ff6b6b' }}>Delete</button>
              </div>
            </div>
            <textarea className="content-input" style={{ color: '#e0e0ff', fontFamily: 'Georgia, serif', lineHeight: 1.8 }} value={selected.content} onChange={(e) => updateEntry(selected.id, { content: e.target.value })} placeholder="Write your secret thoughts..." />
            <div className="editor-footer" style={{ color: '#a0a0cc', borderTop: '1px solid #4a4a7a' }}>
              {selected.content.split(/\s+/).filter(Boolean).length} words · {selected.date}
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ color: '#a0a0cc' }}>
            <h2 style={{ color: '#e0e0ff' }}>🌙 Secret Diary</h2>
            <p>Your private, password-protected journal.</p>
            <button className="primary-btn" style={{ background: '#7c4dff' }} onClick={createEntry}>+ New Entry</button>
          </div>
        )}
      </main>
      {changeDone && <div style={{ position: 'absolute', bottom: 12, right: 12, background: '#2e7d32', color: 'white', padding: '8px 14px', borderRadius: 8, fontSize: 13 }} onClick={() => setChangeDone(false)}>Password changed ✓</div>}
      {showChange && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: '#1a1733', padding: 24, borderRadius: 14, width: 340, border: '1px solid #4a4a7a' }}>
            <h2 style={{ marginTop: 0, color: '#e0e0ff' }}>🔑 Change password</h2>
            <p style={{ color: '#a0a0cc', fontSize: 12 }}>Your diary entries stay exactly as they are.</p>
            <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder="Current password" style={{ width: '100%', padding: 10, marginBottom: 8, border: '1px solid #4a4a7a', borderRadius: 8, background: 'rgba(0,0,0,0.3)', color: '#e0e0ff', boxSizing: 'border-box' }} />
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password" style={{ width: '100%', padding: 10, marginBottom: 8, border: '1px solid #4a4a7a', borderRadius: 8, background: 'rgba(0,0,0,0.3)', color: '#e0e0ff', boxSizing: 'border-box' }} />
            <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && changePassword()} placeholder="Repeat new password" style={{ width: '100%', padding: 10, marginBottom: 8, border: '1px solid #4a4a7a', borderRadius: 8, background: 'rgba(0,0,0,0.3)', color: '#e0e0ff', boxSizing: 'border-box' }} />
            {changeError && <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 8 }}>{changeError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={changePassword} style={{ flex: 1, padding: 10, background: '#7c4dff', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>Change password</button>
              <button onClick={() => { setShowChange(false); setCurrentPw(''); setNewPw(''); setConfirmPw(''); setChangeError(''); }} style={{ flex: 1, padding: 10, background: 'transparent', color: '#e0e0ff', border: '1px solid #4a4a7a', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
