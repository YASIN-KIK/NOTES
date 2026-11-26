import { useEffect, useRef, useState } from 'react';
import mqtt from 'mqtt';
type MqttClient = ReturnType<typeof mqtt.connect>;

type Account = { email: string; name: string; hash: string };
type User = { email: string; name: string };
type Msg = {
  type: 'hello' | 'bye' | 'doc' | 'request' | 'remove' | 'delete';
  from: string;
  peerId?: string;
  target?: string;
  name?: string;
  text?: string;
  title?: string;
};
type Props = {
  inviteCode?: string;
  sourceNote?: { id: string; title: string; content: string } | null;
  onNoteUpdate?: (id: string, patch: { content?: string; title?: string }) => void;
  onCreateShared?: (id: string, title: string, content: string) => void;
  onDeleteShared?: (id: string) => void;
};

const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const ACC_KEY = 'notes-app:collabAccounts';
const USER_KEY = 'notes-app:collabUser';

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
async function hashPw(pw: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function loadAccounts(): Account[] {
  try {
    const raw = localStorage.getItem(ACC_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) as User : null;
  } catch { return null; }
}

const card: React.CSSProperties = { background: 'rgba(127,127,127,0.08)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 };
const input: React.CSSProperties = { width: '100%', padding: 10, marginBottom: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box' };
const btn: React.CSSProperties = { padding: '9px 14px', border: 'none', borderRadius: 8, background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 600 };

export default function Collab({ inviteCode, sourceNote, onNoteUpdate, onCreateShared, onDeleteShared }: Props) {
  const [user, setUser] = useState<User | null>(() => loadUser());
  const [mode, setMode] = useState<'signup' | 'signin'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [activeCode, setActiveCode] = useState('');
  const [role, setRole] = useState<'host' | 'join' | ''>('');
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('');
  const [peers, setPeers] = useState<{ id: string; name: string }[]>([]);
  const [text, setText] = useState(sourceNote?.content || '');
  const [docTitle, setDocTitle] = useState(sourceNote?.title || 'Shared note');
  const clientRef = useRef<MqttClient | null>(null);
  const timerRef = useRef<number | null>(null);
  const meRef = useRef(uid());
  const textRef = useRef(text);
  const titleRef = useRef(docTitle);
  const lastTextRef = useRef(text);
  const lastTitleRef = useRef(docTitle);
  const noteIdRef = useRef(sourceNote?.id || '');
  const codeRef = useRef('');
  const roleRef = useRef<'host' | 'join' | ''>('');

  const publishDoc = () => {
    const c = clientRef.current;
    if (c && codeRef.current && c.connected) {
      c.publish(`notes-app-live/${codeRef.current}`, JSON.stringify({ type: 'doc', from: meRef.current, title: titleRef.current, text: textRef.current }));
    }
  };

  const endSession = (message: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const c = clientRef.current;
    // Graceful end lets the last message (bye / remove / delete) flush out.
    if (c) c.end(false);
    clientRef.current = null; codeRef.current = ''; roleRef.current = '';
    setConnected(false); setActiveCode(''); setRole(''); setPeers([]); setStatus(message);
  };

  const leave = () => {
    const c = clientRef.current;
    if (c && c.connected) {
      c.publish(`notes-app-live/${codeRef.current}`, JSON.stringify({ type: 'bye', from: meRef.current, peerId: meRef.current, name: user?.name }));
    }
    endSession('Left the session.');
  };

  const removePeer = (peerId: string) => {
    const c = clientRef.current;
    if (c && c.connected) {
      c.publish(`notes-app-live/${codeRef.current}`, JSON.stringify({ type: 'remove', from: meRef.current, target: peerId }));
    }
    setPeers((prev) => prev.filter((p) => p.id !== peerId));
  };

  const deleteNote = () => {
    const id = noteIdRef.current;
    const c = clientRef.current;
    if (c && c.connected) {
      c.publish(`notes-app-live/${codeRef.current}`, JSON.stringify({ type: 'delete', from: meRef.current, target: id }));
    }
    if (id) onDeleteShared?.(id);
    endSession('Note deleted for everyone.');
  };

  const start = (code: string, as: 'host' | 'join') => {
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(clean)) { setStatus('Code must be 4-12 letters or numbers.'); return; }
    if (clientRef.current) clientRef.current.end(true);
    codeRef.current = clean;
    roleRef.current = as;
    if (as === 'host' && sourceNote) {
      noteIdRef.current = sourceNote.id;
      textRef.current = sourceNote.content; titleRef.current = sourceNote.title;
      setText(sourceNote.content); setDocTitle(sourceNote.title);
    }
    if (as === 'join') {
      noteIdRef.current = `shared-${clean}`;
      textRef.current = ''; titleRef.current = 'Shared note';
      setText(''); setDocTitle('Shared note');
    }
    lastTextRef.current = textRef.current; lastTitleRef.current = titleRef.current;
    setActiveCode(clean); setRole(as); setStatus(as === 'host' ? 'Sharing your note live...' : 'Connecting to the host...'); setPeers([]);
    const c = mqtt.connect(BROKER, { clientId: `notes-${uid()}`, connectTimeout: 15000, reconnectPeriod: 3000, clean: true });
    clientRef.current = c;
    const topic = `notes-app-live/${clean}`;
    c.on('connect', () => {
      setConnected(true);
      setStatus(as === 'host' ? 'Note shared. Send the code or invite link.' : 'Joined. Waiting for the note...');
      c.subscribe(topic);
      c.publish(topic, JSON.stringify({ type: 'hello', from: meRef.current, peerId: meRef.current, name: user?.name || 'Assistant' }));
      if (as === 'join') c.publish(topic, JSON.stringify({ type: 'request', from: meRef.current }));
    });
    c.on('disconnect', () => { setConnected(false); setStatus('Disconnected. Reconnecting...'); });
    c.on('error', (e) => setStatus('Connection error: ' + e.message));
    c.on('message', (_topic, payload) => {
      let msg: Msg;
      try { msg = JSON.parse(payload.toString()) as Msg; } catch { return; }
      if (msg.from === meRef.current) return;
      if (msg.type === 'hello' && msg.name && msg.peerId) {
        setPeers((prev) => prev.some((p) => p.id === msg.peerId) ? prev : [...prev, { id: msg.peerId!, name: msg.name! }]);
        c.publish(topic, JSON.stringify({ type: 'hello', from: meRef.current, peerId: meRef.current, name: user?.name || 'Assistant' }));
      } else if (msg.type === 'bye' && msg.peerId) {
        setPeers((prev) => prev.filter((p) => p.id !== msg.peerId));
      } else if (msg.type === 'remove' && msg.target === meRef.current) {
        endSession('Removed from the session by the boss.');
        return;
      } else if (msg.type === 'delete' && msg.target) {
        onDeleteShared?.(msg.target);
        endSession('The boss deleted this note.');
        return;
      } else if (msg.type === 'request') {
        publishDoc();
      } else if (msg.type === 'doc' && typeof msg.text === 'string') {
        const incomingText = msg.text;
        const incomingTitle = typeof msg.title === 'string' ? msg.title : titleRef.current;
        if (incomingText === textRef.current && incomingTitle === titleRef.current) return;
        textRef.current = incomingText; titleRef.current = incomingTitle;
        lastTextRef.current = incomingText; lastTitleRef.current = incomingTitle;
        setText(incomingText); setDocTitle(incomingTitle);
        setStatus('Note updated by a collaborator.');
        if (!noteIdRef.current) noteIdRef.current = `shared-${codeRef.current}`;
        if (roleRef.current === 'join' && onCreateShared) onCreateShared(noteIdRef.current, incomingTitle, incomingText);
        else if (roleRef.current === 'host') onNoteUpdate?.(noteIdRef.current, { content: incomingText, title: incomingTitle });
      }
    });
  };

  useEffect(() => {
    return () => { if (clientRef.current) clientRef.current.end(true); if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, []);

  // A ready-made admin account means there is nothing to set up.
  useEffect(() => {
    const accounts = loadAccounts();
    if (!accounts.some((a) => a.email.toLowerCase() === 'admin')) {
      hashPw('admin123').then((h) => {
        const current = loadAccounts();
        if (!current.some((a) => a.email.toLowerCase() === 'admin')) {
          localStorage.setItem(ACC_KEY, JSON.stringify([{ email: 'admin', name: 'Admin', hash: h }, ...current]));
        }
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    textRef.current = text;
    titleRef.current = docTitle;
    if (!connected || (text === lastTextRef.current && docTitle === lastTitleRef.current)) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      lastTextRef.current = text; lastTitleRef.current = docTitle;
      publishDoc();
    }, 350);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, [text, docTitle, connected, activeCode]);

  useEffect(() => {
    if (inviteCode && user) { setCodeInput(inviteCode.toUpperCase()); start(inviteCode, 'join'); }
  }, [inviteCode, user]);

  const signUp = async () => {
    setAuthError('');
    if (!name.trim() || !email.trim() || !password) { setAuthError('Fill in name, username and password.'); return; }
    const accounts = loadAccounts();
    if (accounts.some((a) => a.email.toLowerCase() === email.trim().toLowerCase())) { setAuthError('That username is already taken. Sign in instead.'); return; }
    const next = [...accounts, { email: email.trim(), name: name.trim(), hash: await hashPw(password) }];
    localStorage.setItem(ACC_KEY, JSON.stringify(next));
    const u = { email: email.trim(), name: name.trim() };
    localStorage.setItem(USER_KEY, JSON.stringify(u)); setUser(u); setPassword('');
  };

  const signIn = async () => {
    setAuthError('');
    let account = loadAccounts().find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
    if (!account && email.trim().toLowerCase() === 'admin' && password === 'admin123') {
      account = { email: 'admin', name: 'Admin', hash: await hashPw(password) };
      const current = loadAccounts();
      localStorage.setItem(ACC_KEY, JSON.stringify([account, ...current]));
    }
    if (!account || account.hash !== await hashPw(password)) { setAuthError('Wrong username or password.'); return; }
    const u = { email: account.email, name: account.name };
    localStorage.setItem(USER_KEY, JSON.stringify(u)); setUser(u); setPassword('');
  };

  const signOut = () => {
    if (clientRef.current) leave();
    localStorage.removeItem(USER_KEY); setUser(null); setEmail(''); setPassword(''); setName('');
  };

  const copyInvite = async () => {
    const invite = `notes://join/${activeCode}`;
    try { await navigator.clipboard.writeText(invite); setStatus('Invite link copied: ' + invite); }
    catch { setStatus('Invite code: ' + activeCode); }
  };

  if (!user) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--text)' }}>
        <div style={{ ...card, width: 380 }}>
          <h2 style={{ marginTop: 0 }}>🤝 Collaborate</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Create an account on this device to share or join a note.</p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            <button onClick={() => { setMode('signup'); setAuthError(''); }} style={{ ...btn, flex: 1, background: mode === 'signup' ? 'var(--accent)' : 'rgba(127,127,127,0.08)', color: mode === 'signup' ? '#fff' : 'var(--text)', border: '1px solid var(--border)' }}>Sign up</button>
            <button onClick={() => { setMode('signin'); setAuthError(''); }} style={{ ...btn, flex: 1, background: mode === 'signin' ? 'var(--accent)' : 'rgba(127,127,127,0.08)', color: mode === 'signin' ? '#fff' : 'var(--text)', border: '1px solid var(--border)' }}>Sign in</button>
          </div>
          {mode === 'signup' && <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />}
          <input style={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Username (or email)" />
          <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (mode === 'signup' ? signUp() : signIn())} placeholder="Password" />
          {authError && <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 10 }}>{authError}</div>}
          <button style={{ ...btn, width: '100%' }} onClick={mode === 'signup' ? signUp : signIn}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
          <p style={{ color: '#8fa0ff', fontSize: 12, marginTop: 12 }}>Ready-made admin account — username: <strong>admin</strong> · password: <strong>admin123</strong></p>
          <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 8 }}>Accounts are stored locally on this device. The note itself syncs through a free public relay while the session is live.</p>
        </div>
      </div>
    );
  }

  const active = !!activeCode;
  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 20, overflow: 'auto', background: 'var(--bg)', color: 'var(--text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>🤝 Collaborate</h2>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Signed in as <strong>{user.name}</strong> · <button onClick={signOut} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer' }}>Sign out</button></div>
      </div>

      {!active ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Share a note</h3>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              {sourceNote
                ? <>Currently sharing: <strong>{sourceNote.title || 'Untitled'}</strong>. Both people edit this same note.</>
                : 'Open a note and choose ⋯ → Share this note to host it. Or join with a code below.'}
            </p>
            {sourceNote && <button style={btn} onClick={() => start(newCode(), 'host')}>Start sharing this note</button>}
          </div>
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Join a shared note</h3>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Enter the code the host sent you. The note appears in your notes list and stays in sync.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...input, flex: 1, marginBottom: 0, textTransform: 'uppercase' }} value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} placeholder="CODE" />
              <button style={btn} onClick={() => start(codeInput, 'join')}>Join</button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ ...card, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 320 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Session code</span>
            <strong style={{ fontSize: 24, letterSpacing: 4, color: 'var(--accent)' }}>{activeCode}</strong>
            <span style={{ fontSize: 11, color: role === 'host' ? '#ffb74d' : 'var(--muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '2px 8px' }}>
              {role === 'host' ? '👑 Boss' : 'Assistant'}
            </span>
            {role === 'host' && (
              <>
                <button style={btn} onClick={copyInvite}>+ Add people (copy link)</button>
                <button style={{ ...btn, background: '#c62828', color: '#fff' }} onClick={deleteNote}>Delete note</button>
              </>
            )}
            <button style={{ ...btn, background: 'rgba(127,127,127,0.08)', color: 'var(--text)', border: '1px solid var(--border)' }} onClick={leave}>Leave</button>
          </div>
          <div style={{ fontSize: 12, color: connected ? '#4caf50' : '#ff9800', marginBottom: 8 }}>{connected ? '● Connected' : '○ '}{status}</div>
          {peers.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              {role === 'host' ? 'Assistants' : 'In this note'}:{' '}
              {peers.map((p) => (
                <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8, border: '1px solid var(--border)', borderRadius: 10, padding: '2px 6px' }}>
                  {p.name}
                  {role === 'host' && <button onClick={() => removePeer(p.id)} title={`Remove ${p.name}`} style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', fontSize: 13 }}>✕</button>}
                </span>
              ))}
            </div>
          )}
          <input style={{ ...input, fontSize: 16, fontWeight: 600 }} value={docTitle} onChange={(e) => {
            const v = e.target.value; setDocTitle(v); titleRef.current = v;
            onNoteUpdate?.(noteIdRef.current, { title: v });
          }} placeholder="Note title" />
          <textarea style={{ flex: 1, width: '100%', padding: 14, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box', resize: 'none', fontFamily: 'inherit', fontSize: 14 }} value={text} onChange={(e) => {
            const v = e.target.value; setText(v); textRef.current = v;
            onNoteUpdate?.(noteIdRef.current, { content: v });
          }} placeholder="Write the story together — everyone sees changes live..." />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Edits go straight into the shared note and sync live. Uses a free public relay — don't share secrets.</div>
        </div>
      )}
    </div>
  );
}
