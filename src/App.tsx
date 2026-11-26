import { useEffect, useState, useMemo } from 'react';
import JSZip from 'jszip';
import { io, Socket } from 'socket.io-client';
import { ModeBar } from './ModeBar';
import type { AppMode } from './ModeBar';
import StoryWriter from './StoryWriter';
import SecretDiary from './SecretDiary';
import CodeEditor from './CodeEditor';
import Collab from './Collab';
import './App.css';

type Folder = { id: string; name: string; color: string };
type Note = {
  id: string;
  title: string;
  content: string;
  folderId: string | null;
  tags: string[];
  pinned: boolean;
  favorite: boolean;
  color: string | null;
  trashed: boolean;
  archived: boolean;
  locked: boolean;
  reminderAt: number | null;
  history: string[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = 'notes-app:data';
const THEME_KEY = 'notes-app:theme';
const FONT_KEY = 'notes-app:font';

const FOLDER_COLORS = ['#4f8cff', '#ff6b6b', '#51cf66', '#fcc419', '#cc5de8', '#20c997'];
const NOTE_COLORS = ['#ffd43b', '#ff8787', '#69db7c', '#74c0fc', '#b197fc', '#ffa94d'];

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function loadState(): { notes: Note[]; folders: Folder[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { notes: [], folders: [] };
    const parsed = JSON.parse(raw);
    const notes = Array.isArray(parsed.notes) ? parsed.notes : (Array.isArray(parsed) ? parsed : []);
    const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
    // migrate old notes
    return {
      notes: notes.map((n: any) => ({
        id: n.id, title: n.title ?? 'Untitled', content: n.content ?? '',
        folderId: n.folderId ?? null, tags: n.tags ?? [], pinned: !!n.pinned,
        favorite: !!n.favorite, color: n.color ?? null, trashed: !!n.trashed,
        archived: !!n.archived,
        locked: !!n.locked,
        reminderAt: n.reminderAt ?? null,
        history: Array.isArray(n.history) ? n.history : [],
        createdAt: n.createdAt ?? Date.now(), updatedAt: n.updatedAt ?? Date.now(),
      })),
      folders,
    };
  } catch { return { notes: [], folders: [] }; }
}

function formatDate(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function renderMarkdown(md: string): string {
  // minimal markdown -> html (escape first)
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc;
  // code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // headings
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  // bold/italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // wiki links [[Note Title]]
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<a href="#" class="wiki-link" data-wiki="$1">$1</a>');
  // links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // checklists
  html = html.replace(/^\- \[x\] (.*)$/gim, '<li><input type="checkbox" checked disabled /> $1</li>');
  html = html.replace(/^\- \[ \] (.*)$/gim, '<li><input type="checkbox" disabled /> $1</li>');
  // lists
  html = html.replace(/^\- (.*)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // paragraphs
  html = html.split(/\n{2,}/).map((p) => p.trim() ? (p.startsWith('<') ? p : `<p>${p.replace(/\n/g, '<br/>')}</p>`) : '').join('\n');
  return html;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptText(password: string, plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, new TextEncoder().encode(plaintext));
  const buf = new Uint8Array(salt.length + iv.length + ct.byteLength);
  buf.set(salt, 0); buf.set(iv, 16); buf.set(new Uint8Array(ct), 28);
  return btoa(String.fromCharCode(...buf));
}
async function decryptText(password: string, packed: string): Promise<string> {
  const buf = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  const salt = buf.slice(0, 16); const iv = buf.slice(16, 28); const ct = buf.slice(28);
  const key = await deriveKey(password, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource);
  return new TextDecoder().decode(pt);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

type View = 'all' | 'favorites' | 'pinned' | 'trash' | 'archive' | 'calendar' | 'graph' | 'folder';

export default function App() {
  const [mode, setMode] = useState<AppMode>('notes');
  const [collabInvite, setCollabInvite] = useState('');
  const [collabNote, setCollabNote] = useState<{ id: string; title: string; content: string } | null>(null);
  const init = loadState();

  const showToast = (msg: string, type: string = 'info') => {
    const id = uid();
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  };
  const [notes, setNotes] = useState<Note[]>(init.notes);
  const [folders, setFolders] = useState<Folder[]>(init.folders);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem(THEME_KEY) as any) || 'dark');
  const [fontSize, setFontSize] = useState<number>(() => Number(localStorage.getItem(FONT_KEY)) || 16);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResult, setAiResult] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState(() => localStorage.getItem('notes-app:aiBaseUrl') || 'https://api.openai.com/v1');
  const [aiApiKey, setAiApiKey] = useState(() => localStorage.getItem('notes-app:aiApiKey') || '');
  const [aiModel, setAiModel] = useState(() => localStorage.getItem('notes-app:aiModel') || 'gpt-4o-mini');
  const [backendUrl, setBackendUrl] = useState(() => localStorage.getItem('notes-app:backendUrl') || 'http://localhost:3000');
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [appLockHash, setAppLockHash] = useState(() => localStorage.getItem('notes-app:appLockHash') || '');
  const [showAppLock, setShowAppLock] = useState(() => !!localStorage.getItem('notes-app:appLockHash'));
  const [lockInput, setLockInput] = useState('');
  const [lockError, setLockError] = useState('');
  const [showWelcome, setShowWelcome] = useState(() => localStorage.getItem('notes-app:signupDone') !== '1');
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupStatus, setSignupStatus] = useState('');
  const [view, setView] = useState<View>('all');
  const [calendarMonth, setCalendarMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [calendarDay, setCalendarDay] = useState<number | null>(null);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [sort, setSort] = useState<'updated' | 'created' | 'title'>('updated');
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [listening, setListening] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [fontFamily, setFontFamily] = useState(() => localStorage.getItem('notes-app:fontFamily') || 'system');
  const [wordGoal, setWordGoal] = useState<number>(() => Number(localStorage.getItem('notes-app:wordGoal')) || 0);
  const [showStats, setShowStats] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPomodoro, setShowPomodoro] = useState(false);
  const [pomoSeconds, setPomoSeconds] = useState(25 * 60);
  const [pomoRunning, setPomoRunning] = useState(false);
  const [pomoMode, setPomoMode] = useState<'work' | 'break'>('work');
  const [compact, setCompact] = useState(() => localStorage.getItem('notes-app:compact') === '1');
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: string; msg: string; type: string }[]>([]);
  const [updateVersion, setUpdateVersion] = useState('');
  const [, setLastBackup] = useState(() => localStorage.getItem('notes-app:lastBackup') || '');
  const [collabRoom, setCollabRoom] = useState('');
  const [collabConnected, setCollabConnected] = useState(false);
  const [collabStatus, setCollabStatus] = useState('');
  const [collabSocket, setCollabSocket] = useState<Socket | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [syncToken, setSyncToken] = useState(() => localStorage.getItem('notes-app:syncToken') || '');
  const [syncEmail, setSyncEmail] = useState(() => localStorage.getItem('notes-app:syncEmail') || '');
  const [syncName, setSyncName] = useState(() => localStorage.getItem('notes-app:syncName') || '');
  const [syncStatus, setSyncStatus] = useState('');
  const [lastSync, setLastSync] = useState(() => localStorage.getItem('notes-app:lastSync') || '');
  const [autoSync, setAutoSync] = useState(() => localStorage.getItem('notes-app:autoSync') === '1');
  const [syncEmailInput, setSyncEmailInput] = useState('');
  const [syncPasswordInput, setSyncPasswordInput] = useState('');
  const [syncNameInput, setSyncNameInput] = useState('');
  const [multiMode, setMultiMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [paletteQuery, setPaletteQuery] = useState('');
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ notes, folders }));
  }, [notes, folders]);
  useEffect(() => {
    if (!showMore && !showAdvanced) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.more-menu') || t.closest('.icon-action') || t.closest('.sidebar-footer .icon-btn')) return;
      setShowMore(false);
      setShowAdvanced(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showMore, showAdvanced]);
  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem(FONT_KEY, String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem('notes-app:aiBaseUrl', aiBaseUrl); }, [aiBaseUrl]);
  useEffect(() => { localStorage.setItem('notes-app:aiApiKey', aiApiKey); }, [aiApiKey]);
  useEffect(() => { localStorage.setItem('notes-app:aiModel', aiModel); }, [aiModel]);
  useEffect(() => { localStorage.setItem('notes-app:backendUrl', backendUrl); }, [backendUrl]);
  useEffect(() => { localStorage.setItem('notes-app:fontFamily', fontFamily); }, [fontFamily]);
  useEffect(() => { localStorage.setItem('notes-app:wordGoal', String(wordGoal)); }, [wordGoal]);
  useEffect(() => { localStorage.setItem('notes-app:compact', compact ? '1' : '0'); }, [compact]);
  useEffect(() => { localStorage.setItem('notes-app:syncToken', syncToken); }, [syncToken]);
  useEffect(() => { localStorage.setItem('notes-app:syncEmail', syncEmail); }, [syncEmail]);
  useEffect(() => { localStorage.setItem('notes-app:syncName', syncName); }, [syncName]);
  useEffect(() => { localStorage.setItem('notes-app:lastSync', lastSync); }, [lastSync]);
  useEffect(() => { localStorage.setItem('notes-app:autoSync', autoSync ? '1' : '0'); }, [autoSync]);
  useEffect(() => {
    window.electronAPI?.getAutoLaunch().then((r) => { if (r?.ok) setAutoLaunch(!!r.enabled); });
  }, []);

  // Fire due reminders
  useEffect(() => {
    const check = () => {
      const now = Date.now();
      notes.forEach((n) => {
        if (n.reminderAt && n.reminderAt <= now && !n.trashed) {
          try {
            if ('Notification' in window) {
              if (Notification.permission === 'granted') {
                new Notification('Reminder: ' + (n.title || 'Untitled'), { body: n.content.slice(0, 120) });
              } else if (Notification.permission !== 'denied') {
                Notification.requestPermission();
              }
            }
          } catch {}
          updateNote(n.id, { reminderAt: null });
        }
      });
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, [notes]);

  // Auto-sync
  useEffect(() => {
    if (!syncToken || !autoSync) return;
    doSync(syncToken);
    const id = setInterval(() => doSync(syncToken), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [syncToken, autoSync]);

  // Global quick-capture (Ctrl+Shift+N)
  useEffect(() => {
    const off = window.electronAPI?.onQuickCapture(() => createNote(null));
    return () => { if (off) off(); };
  }, []);

  // Pomodoro timer
  useEffect(() => {
    if (!pomoRunning) return;
    const id = setInterval(() => {
      setPomoSeconds((s) => {
        if (s <= 1) {
          setPomoRunning(false);
          try { if ('Notification' in window && Notification.permission === 'granted') new Notification(pomoMode === 'work' ? 'Work session done! Take a break.' : 'Break over! Back to work.'); } catch {}
          if (pomoMode === 'work') { setPomoMode('break'); setPomoSeconds(5 * 60); }
          else { setPomoMode('work'); setPomoSeconds(25 * 60); }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [pomoRunning, pomoMode]);

  // Graph view rendering
  useEffect(() => {
    if (view !== 'graph') return;
    const canvas = document.getElementById('graphCanvas') as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const notesPool = notes.filter((n) => !n.trashed);
    // map title -> note
    const byTitle = new Map(notesPool.map((n) => [n.title.toLowerCase(), n]));
    const nodes = notesPool.map((n, i) => ({
      id: n.id, title: n.title || 'Untitled',
      x: 100 + (i % 8) * 90, y: 80 + Math.floor(i / 8) * 90,
      vx: 0, vy: 0,
    }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edges: { a: string; b: string }[] = [];
    notesPool.forEach((n) => {
      const links = [...n.content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
      links.forEach((t) => {
        const target = byTitle.get(t.toLowerCase());
        if (target && target.id !== n.id) edges.push({ a: n.id, b: target.id });
      });
    });
    // simple force layout iterations
    for (let iter = 0; iter < 60; iter++) {
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x; const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 800 / (dist * dist);
          nodes[i].vx -= (dx / dist) * force; nodes[i].vy -= (dy / dist) * force;
          nodes[j].vx += (dx / dist) * force; nodes[j].vy += (dy / dist) * force;
        }
      }
      // attraction along edges
      edges.forEach((e) => {
        const a = nodeMap.get(e.a)!; const b = nodeMap.get(e.b)!;
        const dx = b.x - a.x; const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 120) * 0.02;
        a.vx += (dx / dist) * force; a.vy += (dy / dist) * force;
        b.vx -= (dx / dist) * force; b.vy -= (dy / dist) * force;
      });
      // center gravity + apply
      nodes.forEach((n) => {
        n.vx += (400 - n.x) * 0.001; n.vy += (300 - n.y) * 0.001;
        n.x += n.vx * 0.5; n.y += n.vy * 0.5;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x = Math.max(20, Math.min(canvas.width - 20, n.x));
        n.y = Math.max(20, Math.min(canvas.height - 20, n.y));
      });
    }
    // draw
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#4f8cff55';
    ctx.lineWidth = 1.5;
    edges.forEach((e) => {
      const a = nodeMap.get(e.a)!; const b = nodeMap.get(e.b)!;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    nodes.forEach((n) => {
      ctx.beginPath(); ctx.arc(n.x, n.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#4f8cff'; ctx.fill();
      ctx.fillStyle = '#e4e4e7'; ctx.font = '11px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText(n.title.slice(0, 16), n.x, n.y - 12);
    });
    // click handler
    const onClick = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
      const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
      const hit = nodes.find((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < 12 ** 2);
      if (hit) { setSelectedId(hit.id); setView('all'); }
    };
    canvas.addEventListener('click', onClick);
    return () => canvas.removeEventListener('click', onClick);
  }, [view, notes]);

  // Auto-update notification
  useEffect(() => {
    const off = window.electronAPI?.onUpdateAvailable((v) => setUpdateVersion(v || 'new'));
    return () => { if (off) off(); };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setShowPalette((v) => !v); }
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); createNote(null); }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); document.querySelector<HTMLInputElement>('.search')?.focus(); }
      if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); setPreview((v) => !v); }
      if (e.key === 'Escape') { setShowPalette(false); setShowSettings(false); setShowWelcome(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // A notes://join/CODE link opens this app and drops straight into the session.
  useEffect(() => {
    const off = window.electronAPI?.onCollabJoin?.((code: string) => {
      setCollabInvite(code.toUpperCase());
      setMode('collab');
    });
    return () => off?.();
  }, []);

  const selected = notes.find((n) => n.id === selectedId) || null;

  const visibleNotes = useMemo(() => {
    let list = notes.filter((n) => {
      if (view === 'trash') return n.trashed;
      if (view === 'archive') return n.archived && !n.trashed;
      if (n.trashed || n.archived) return false;
      if (view === 'favorites') return n.favorite;
      if (view === 'pinned') return n.pinned;
      if (view === 'folder') return n.folderId === activeFolder;
      return true;
    });
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)));
    if (colorFilter) list = list.filter((n) => n.color === colorFilter);
    // sort
    list = [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return list;
  }, [notes, view, activeFolder, query, sort]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    notes.forEach((n) => n.tags.forEach((t) => set.add(t)));
    return [...set].sort();
  }, [notes]);

  const createNote = (folderId: string | null = activeFolder) => {
    const n: Note = {
      id: uid(), title: 'Untitled', content: '', folderId,
      tags: [], pinned: false, favorite: false, color: null, trashed: false, archived: false, locked: false, reminderAt: null, history: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    setNotes((prev) => [n, ...prev]);
    setSelectedId(n.id);
    setView(folderId ? 'folder' : 'all');
    if (folderId) setActiveFolder(folderId);
  };

  const updateNote = (id: string, patch: Partial<Note>) => {
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n));
    if (collabRoom === id && (patch.content !== undefined || patch.title !== undefined)) {
      const n = notes.find((x) => x.id === id);
      if (n) broadcastCollab(id, patch.content ?? n.content, patch.title ?? n.title);
    }
  };

  const trashNote = (id: string) => {
    updateNote(id, { trashed: true });
    if (selectedId === id) setSelectedId(null);
  };
  const restoreNote = (id: string) => updateNote(id, { trashed: false });
  const deleteForever = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const f: Folder = { id: uid(), name, color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length] };
    setFolders((prev) => [...prev, f]);
    setNewFolderName('');
  };
  const deleteFolder = (id: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setNotes((prev) => prev.map((n) => n.folderId === id ? { ...n, folderId: null } : n));
    if (activeFolder === id) { setActiveFolder(null); setView('all'); }
  };

  const exportNote = (n: Note) => {
    const blob = new Blob([`# ${n.title}\n\n${n.content}`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${n.title || 'note'}.md`; a.click();
    URL.revokeObjectURL(url);
  };
  const exportAll = () => {
    const blob = new Blob([JSON.stringify({ notes, folders }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'notes-backup.json'; a.click();
    URL.revokeObjectURL(url);
    const now = new Date().toISOString();
    localStorage.setItem('notes-app:lastBackup', now);
    setLastBackup(now);
  };
  const exportPDF = async () => {
    if (!selected || !window.electronAPI) return;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:serif;padding:24px;line-height:1.6}h1,h2,h3{margin-top:16px}code{background:#eee;padding:2px 4px;border-radius:4px}pre{background:#eee;padding:10px;border-radius:6px}img{max-width:100%}</style></head><body><h1>${selected.title}</h1>${renderMarkdown(selected.content)}</body></html>`;
    const res = await window.electronAPI.printToPDF(html);
    if (res.ok && res.data) {
      const blob = new Blob([new Uint8Array(res.data)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${selected.title || 'note'}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } else {
      showToast(res.error || 'PDF export failed', 'error');
    }
  };
  const importNotes = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const ns = Array.isArray(data.notes) ? data.notes : [];
        const fs = Array.isArray(data.folders) ? data.folders : [];
        setNotes((prev) => [...ns.map((n: any) => ({ ...n, id: uid() })), ...prev]);
        setFolders((prev) => [...prev, ...fs.map((f: any) => ({ ...f, id: uid() }))]);
      } catch { showToast('Invalid backup file', 'error'); }
    };
    reader.readAsText(file);
  };

  const toggleTag = (noteId: string, tag: string) => {
    const n = notes.find((x) => x.id === noteId);
    if (!n) return;
    const tags = n.tags.includes(tag) ? n.tags.filter((t) => t !== tag) : [...n.tags, tag];
    updateNote(noteId, { tags });
  };

  const runAI = async (system: string, user: string) => {
    if (!window.electronAPI) { setAiError('AI is only available in the desktop app.'); return; }
    if (!aiApiKey && !aiBaseUrl.includes('localhost') && !aiBaseUrl.includes('127.0.0.1')) {
      setAiError('Please set your API key in Settings (⚙).');
      return;
    }
    setAiLoading(true); setAiError(''); setAiResult('');
    const res = await window.electronAPI.aiChat({
      baseUrl: aiBaseUrl, apiKey: aiApiKey, model: aiModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    setAiLoading(false);
    if (res.ok) setAiResult(res.content || ''); else setAiError(res.error || 'Unknown error');
  };

  const doSignup = async () => {
    if (!signupEmail.trim()) { setSignupStatus('Email is required'); return; }
    setSignupStatus('Signing up...');
    try {
      const res = await fetch(backendUrl.replace(/\/$/, '') + '/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: signupName.trim(), email: signupEmail.trim(), device: navigator.userAgent }),
      });
      const data = await res.json();
      if (data.ok) {
        localStorage.setItem('notes-app:signupDone', '1');
        setShowWelcome(false);
        setSignupStatus('');
      } else {
        setSignupStatus(data.error || 'Signup failed');
      }
    } catch (e) {
      setSignupStatus('Could not reach server (offline?). You can skip.');
    }
  };
  const skipSignup = async () => {
    try {
      await fetch(backendUrl.replace(/\/$/, '') + '/api/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: navigator.userAgent }),
      });
    } catch {}
    localStorage.setItem('notes-app:signupDone', '1');
    setShowWelcome(false);
  };

  const lockNote = async () => {
    if (!selected) return;
    const pw = prompt('Set a password to lock this note:');
    if (!pw) return;
    const ct = await encryptText(pw, selected.content);
    updateNote(selected.id, { content: ct, locked: true });
  };
  const unlockNote = async () => {
    if (!selected) return;
    const pw = prompt('Enter password to unlock:');
    if (!pw) return;
    try {
      const pt = await decryptText(pw, selected.content);
      updateNote(selected.id, { content: pt, locked: false });
    } catch {
      showToast('Wrong password or corrupted data.', 'error');
    }
  };

  const tryAppUnlock = async () => {
    const h = await sha256Hex(lockInput);
    if (h === appLockHash) {
      setShowAppLock(false); setLockInput(''); setLockError('');
    } else {
      setLockError('Wrong password');
    }
  };
  const setAppLock = async () => {
    if (appLockHash) {
      const old = prompt('Enter your current app lock password:');
      if (old === null) return;
      if (await sha256Hex(old) !== appLockHash) { showToast('Wrong current password.', 'error'); return; }
    }
    const pw = prompt('Set new app lock password (leave empty to remove lock):');
    if (pw === null) return;
    if (pw === '') {
      localStorage.removeItem('notes-app:appLockHash');
      setAppLockHash(''); showToast('App lock removed.', 'success');
    } else {
      const h = await sha256Hex(pw);
      localStorage.setItem('notes-app:appLockHash', h);
      setAppLockHash(h); showToast('App lock set.', 'success');
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const duplicateNote = () => {
    if (!selected) return;
    const n: Note = { ...selected, id: uid(), title: selected.title + ' (copy)', createdAt: Date.now(), updatedAt: Date.now() };
    setNotes((prev) => [n, ...prev]);
    setSelectedId(n.id);
  };
  const createDailyNote = () => {
    const today = new Date().toLocaleDateString();
    const existing = notes.find((n) => n.title === `Journal — ${today}` && !n.trashed);
    if (existing) { setSelectedId(existing.id); return; }
    const n: Note = {
      id: uid(), title: `Journal — ${today}`, content: `## ${today}\\n\\n**Mood:** \\n**Highlights:**\\n- \\n\\n**Tomorrow:**\\n- [ ] `,
      folderId: null, tags: ['journal'], pinned: false, favorite: false, color: null, trashed: false, archived: false, locked: false, reminderAt: null, history: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    setNotes((prev) => [n, ...prev]);
    setSelectedId(n.id);
  };
  const openRandomNote = () => {
    const pool = notes.filter((n) => !n.trashed);
    if (pool.length === 0) return;
    const n = pool[Math.floor(Math.random() * pool.length)];
    setSelectedId(n.id);
  };
  const exportMarkdownZip = async () => {
    const zip = new JSZip();
    notes.filter((n) => !n.trashed).forEach((n) => {
      const folder = n.folderId ? (folders.find((f) => f.id === n.folderId)?.name || 'Uncategorized') : 'Uncategorized';
      zip.folder(folder)?.file(`${n.title || 'untitled'}.md`, `# ${n.title}\\n\\n${n.content}`);
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'notes-export.zip'; a.click();
    URL.revokeObjectURL(url);
  };
  const importMarkdownFiles = (files: FileList) => {
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        const title = file.name.replace(/\.md$/i, '');
        const n: Note = {
          id: uid(), title, content: text, folderId: null, tags: [], pinned: false, favorite: false, color: null, trashed: false, archived: false, locked: false, reminderAt: null, history: [],
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        setNotes((prev) => [n, ...prev]);
      };
      reader.readAsText(file);
    });
  };
  const backlinks = selected ? notes.filter((n) => !n.trashed && n.id !== selected.id && n.content.includes(`[[${selected.title}]]`)) : [];

  const apiBase = () => backendUrl.replace(/\/$/, '');

  const syncRegister = async () => {
    if (!syncEmailInput || !syncPasswordInput) { setSyncStatus('Email and password required'); return; }
    setSyncStatus('Registering...');
    try {
      const res = await fetch(apiBase() + '/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: syncNameInput, email: syncEmailInput, password: syncPasswordInput }),
      });
      const data = await res.json();
      if (!data.ok) { setSyncStatus(data.error || 'Register failed'); return; }
      setSyncToken(data.token); setSyncEmail(syncEmailInput); setSyncName(syncNameInput || syncEmailInput);
      setSyncStatus('Registered. Syncing...');
      await doSync(data.token);
    } catch (e) { setSyncStatus('Network error'); }
  };

  const syncLogin = async () => {
    if (!syncEmailInput || !syncPasswordInput) { setSyncStatus('Email and password required'); return; }
    setSyncStatus('Logging in...');
    try {
      const res = await fetch(apiBase() + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: syncEmailInput, password: syncPasswordInput }),
      });
      const data = await res.json();
      if (!data.ok) { setSyncStatus(data.error || 'Login failed'); return; }
      setSyncToken(data.token); setSyncEmail(syncEmailInput); setSyncName(data.name || syncEmailInput);
      setSyncStatus('Logged in. Syncing...');
      await doSync(data.token);
    } catch (e) { setSyncStatus('Network error'); }
  };

  const syncLogout = () => {
    setSyncToken(''); setSyncEmail(''); setSyncName(''); setSyncStatus('Logged out'); setLastSync('');
  };

  const doSync = async (token?: string) => {
    const t = token || syncToken;
    if (!t) { setSyncStatus('Not logged in'); return; }
    setSyncStatus('Syncing...');
    try {
      // push local
      await fetch(apiBase() + '/api/sync/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-token': t },
        body: JSON.stringify({ notes, folders }),
      });
      // pull remote
      const res = await fetch(apiBase() + '/api/sync/pull', { headers: { 'x-user-token': t } });
      const data = await res.json();
      if (data.ok) {
        // merge: combine local + remote by id, keep newer updatedAt
        const remoteNotes = data.notes || [];
        const remoteFolders = data.folders || [];
        setNotes((prev) => {
          const map = new Map(prev.map((n) => [n.id, n]));
          remoteNotes.forEach((rn: Note) => {
            const local = map.get(rn.id);
            if (!local || (rn.updatedAt || 0) > (local.updatedAt || 0)) map.set(rn.id, rn);
          });
          return Array.from(map.values());
        });
        setFolders((prev) => {
          const map = new Map(prev.map((f) => [f.id, f]));
          remoteFolders.forEach((rf: Folder) => { if (!map.has(rf.id)) map.set(rf.id, rf); });
          return Array.from(map.values());
        });
        const now = new Date().toISOString();
        setLastSync(now);
        setSyncStatus('Synced');
      } else {
        setSyncStatus(data.error || 'Sync failed');
      }
    } catch (e) { setSyncStatus('Network error'); }
  };

  const startCollab = (noteId: string) => {
    if (collabSocket) { collabSocket.disconnect(); }
    const s = io(backendUrl.replace(/\/$/, ''), { transports: ['websocket'] });
    s.on('connect', () => {
      setCollabConnected(true);
      setCollabStatus('Connected');
      s.emit('join-note', noteId);
      setCollabRoom(noteId);
    });
    s.on('disconnect', () => { setCollabConnected(false); setCollabStatus('Disconnected'); });
    s.on('peer-joined', () => setCollabStatus('Peer joined'));
    s.on('note-change', ({ content, title, from }) => {
      if (from === s.id) return;
      setNotes((prev) => prev.map((n) => n.id === noteId ? { ...n, content, title: title || n.title, updatedAt: Date.now() } : n));
    });
    setCollabSocket(s);
  };

  const stopCollab = () => {
    if (collabSocket) {
      if (collabRoom) collabSocket.emit('leave-note', collabRoom);
      collabSocket.disconnect();
    }
    setCollabSocket(null); setCollabConnected(false); setCollabStatus(''); setCollabRoom('');
  };

  const broadcastCollab = (noteId: string, content: string, title: string) => {
    if (collabSocket && collabConnected && collabRoom === noteId) {
      collabSocket.emit('note-change', { noteId, content, title });
    }
  };

  const joinCollab = () => {
    if (!joinCode.trim()) return;
    // find note by id or create placeholder
    const existing = notes.find((n) => n.id === joinCode.trim());
    if (existing) {
      setSelectedId(existing.id);
      startCollab(existing.id);
    } else {
      // create a placeholder note with that id
      const n: Note = { id: joinCode.trim(), title: 'Shared note', content: '', folderId: null, tags: ['shared'], pinned: false, favorite: false, color: null, trashed: false, archived: false, locked: false, reminderAt: null, history: [], createdAt: Date.now(), updatedAt: Date.now() };
      setNotes((prev) => [n, ...prev]);
      setSelectedId(n.id);
      startCollab(n.id);
    }
    setJoinCode('');
  };

  // A guest gets the host's note copied into their own notes list, then both
  // people keep editing that same document through the live session.
  const createSharedNote = (id: string, title: string, content: string) => {
    setNotes((prev) => {
      if (prev.some((n) => n.id === id)) {
        return prev.map((n) => n.id === id ? { ...n, title, content, updatedAt: Date.now() } : n);
      }
      const note: Note = {
        id, title, content, folderId: null, tags: ['shared'], pinned: false, favorite: false,
        color: null, trashed: false, archived: false, locked: false, reminderAt: null,
        history: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      return [note, ...prev];
    });
    setSelectedId(id);
    setView('all');
  };

  const deleteSharedNote = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    setSelectedId((prev) => prev === id ? null : prev);
  };

  const handlePreviewClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.classList?.contains('wiki-link')) {
      e.preventDefault();
      const title = target.getAttribute('data-wiki') || '';
      const found = notes.find((n) => !n.trashed && n.title.toLowerCase() === title.toLowerCase());
      if (found) setSelectedId(found.id);
      else {
        const n = { id: uid(), title, content: '', folderId: null, tags: [], pinned: false, favorite: false, color: null, trashed: false, archived: false, locked: false, reminderAt: null, history: [], createdAt: Date.now(), updatedAt: Date.now() };
        setNotes((prev) => [n, ...prev]);
        setSelectedId(n.id);
      }
      return;
    }
    if (!selected || selected.locked) return;
    const t = target as HTMLInputElement;
    if (t.tagName !== 'INPUT' || !t.classList.contains('cl-toggle')) return;
    const idx = Number(t.dataset.cl);
    const lines = selected.content.split('\\n');
    let count = 0;
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^- \\[[ x]\\] /.test(lines[i])) {
        if (count === idx) { found = i; break; }
        count++;
      }
    }
    if (found >= 0) {
      const line = lines[found];
      const toggled = line.replace(/^- \\[ \\]/, '- [x]').replace(/^- \\[x\\]/, '- [ ]');
      lines[found] = toggled;
      updateNote(selected.id, { content: lines.join('\\n') });
    }
  };

  const saveVersion = () => {
    if (!selected || !selected.content.trim()) return;
    const hist = [selected.content, ...(selected.history || [])].filter((c, i, arr) => i === 0 || c !== arr[i - 1]).slice(0, 10);
    updateNote(selected.id, { history: hist });
    showToast('Version saved', 'success');
  };

  const addChecklist = () => {
    if (!selected) return;
    const pos = (document.querySelector('.content-input') as HTMLTextAreaElement)?.selectionStart ?? selected.content.length;
    updateNote(selected.id, { content: selected.content.slice(0, pos) + '- [ ] ' + selected.content.slice(pos) });
  };

  const applyTemplate = (v: string) => {
    if (!selected || !v) return;
    const templates: Record<string, string> = {
      meeting: '## Meeting notes\n\n**Date:** ' + new Date().toLocaleDateString() + '\n**Attendees:**\n\n### Agenda\n- \n\n### Action items\n- [ ] ',
      journal: '## Daily journal\n\n**Mood:**\n**Highlights:**\n- \n\n**Tomorrow:**\n- [ ] ',
      project: '## Project plan\n\n**Goal:**\n**Deadline:**\n\n### Tasks\n- [ ] \n\n### Notes\n- ',
      book: '## Book notes\n\n**Title:**\n**Author:**\n\n### Key ideas\n- \n\n### Quotes\n> ',
    };
    const tpl = templates[v];
    if (tpl === undefined) return;
    updateNote(selected.id, { content: selected.content ? selected.content + '\n\n' + tpl : tpl });
  };

  const startVoice = () => {
    if (!selected) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showToast('Speech recognition not supported here', 'error'); return; }
    if (listening) { setListening(false); return; }
    const noteId = selected.id;
    const base = selected.content;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    let finalText = '';
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
      }
    };
    rec.onend = () => {
      setListening(false);
      if (finalText.trim()) updateNote(noteId, { content: base + (base ? '\n' : '') + finalText.trim() });
    };
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  if (mode !== 'notes') {
    const Comp = mode === 'story' ? StoryWriter : mode === 'secret' ? SecretDiary : mode === 'collab' ? Collab : CodeEditor;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <ModeBar mode={mode} onChange={setMode} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {mode === 'collab' ? (
            <Collab
              inviteCode={collabInvite}
              sourceNote={collabNote}
              onNoteUpdate={(id, patch) => updateNote(id, patch)}
              onCreateShared={createSharedNote}
              onDeleteShared={deleteSharedNote}
            />
          ) : <Comp />}
        </div>
      </div>
    );
  }

  return (
    <div className="app" style={{ fontSize: `${fontSize}px` }}>
      {!focusMode && (
      <aside className={compact ? 'sidebar compact' : 'sidebar'}>
        <div className="sidebar-header">
          <h1>Notes</h1>
          <div className="header-actions">
            <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
            <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </div>
        <div className="sidebar-content">
        <button className="primary-btn" onClick={() => createNote(null)}>+ New note</button>
        <input className="search" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} />

        <div className="filter-row">
          <button className={view === 'all' ? 'chip active' : 'chip'} onClick={() => { setView('all'); setActiveFolder(null); }}>All</button>
          <button className={view === 'pinned' ? 'chip active' : 'chip'} onClick={() => { setView('pinned'); setActiveFolder(null); }}>Pinned</button>
          <button className={view === 'favorites' ? 'chip active' : 'chip'} onClick={() => { setView('favorites'); setActiveFolder(null); }}>Starred</button>
          <button className={view === 'trash' ? 'chip active' : 'chip'} onClick={() => { setView('trash'); setActiveFolder(null); }}>Trash</button>
          <select className="sort-mini" value={sort} onChange={(e) => setSort(e.target.value as any)} title="Sort by">
            <option value="updated">Recent</option>
            <option value="created">Created</option>
            <option value="title">Title</option>
          </select>
        </div>

        {folders.length > 0 && (
          <div className="filter-row">
            {folders.map((f) => (
              <button key={f.id} className={view === 'folder' && activeFolder === f.id ? 'chip active' : 'chip'} onClick={() => { setView('folder'); setActiveFolder(f.id); }} onContextMenu={(e) => { e.preventDefault(); if (confirm(`Delete folder "${f.name}"?`)) deleteFolder(f.id); }} title={`${f.name} · right-click to delete`}>
                <span className="folder-dot" style={{ background: f.color }} />{f.name}
              </button>
            ))}
          </div>
        )}

        {multiMode && (
          <div className="inline-row">
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{selectedIds.size} selected</span>
            <button className="small-btn" onClick={() => { setNotes((prev) => prev.map((n) => selectedIds.has(n.id) ? { ...n, trashed: true } : n)); setSelectedIds(new Set()); }}>Trash</button>
            <button className="small-btn" onClick={() => { setNotes((prev) => prev.filter((n) => !selectedIds.has(n.id))); setSelectedIds(new Set()); setMultiMode(false); }} style={{ background: 'var(--danger)' }}>Delete</button>
            <button className="small-btn secondary" onClick={() => { setMultiMode(false); setSelectedIds(new Set()); }}>Cancel</button>
          </div>
        )}

        <ul className="note-list">
          {visibleNotes.length === 0 && <li className="empty">No notes yet</li>}
          {visibleNotes.map((n) => (
            <li key={n.id} className={n.id === selectedId ? 'active' : ''} onClick={() => {
              if (multiMode) { toggleSelect(n.id); return; }
              setSelectedId(n.id);
              // Calendar and Graph replace the editor pane. Selecting a note must
              // bring the editor back, otherwise the click appears to do nothing.
              if (view === 'calendar' || view === 'graph') setView('all');
            }} style={n.color ? { borderLeft: `3px solid ${n.color}` } : {}}>
              {multiMode && <input type="checkbox" checked={selectedIds.has(n.id)} onChange={() => toggleSelect(n.id)} onClick={(e) => e.stopPropagation()} />}
              <div className="note-row">
                <span className="note-title">{n.pinned ? '📌 ' : ''}{n.locked ? '🔒 ' : ''}{n.title || 'Untitled'}</span>
                {n.favorite && <span className="star-mini">★</span>}
              </div>
              <div className="note-preview">{n.content.slice(0, 70) || 'Empty note'}</div>
            </li>
          ))}
        </ul>
        </div>

        <div className="sidebar-footer">
          <div style={{ position: 'relative', display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="icon-btn" title="More" onClick={() => setShowAdvanced((v) => !v)}>⋯</button>
            <div style={{ flex: 1 }} />
            <ModeBar mode={mode} onChange={setMode} compact />
            {showAdvanced && (
              <div className="more-menu" style={{ bottom: 44, left: 0, right: 'auto', top: 'auto' }}>
                <div className="menu-group">
                  <div className="menu-label">Folders</div>
                  <div className="inline-row">
                    <input className="small-input" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="New folder" onKeyDown={(e) => e.key === 'Enter' && createFolder()} />
                    <button className="small-btn" onClick={createFolder}>Add</button>
                  </div>
                </div>
                <div className="menu-group">
                  <div className="menu-label">Views</div>
                  <button className="menu-item" onClick={() => { setView('archive'); setActiveFolder(null); setShowAdvanced(false); }}>Archive</button>
                  <button className="menu-item" onClick={() => { setView('calendar'); setActiveFolder(null); setShowAdvanced(false); }}>Calendar</button>
                  <button className="menu-item" onClick={() => { setView('graph'); setActiveFolder(null); setShowAdvanced(false); }}>Graph</button>
                  <button className="menu-item" onClick={() => { setMode('collab'); setShowAdvanced(false); }}>🤝 Collaborate live</button>
                  <button className="menu-item" onClick={() => { createDailyNote(); setShowAdvanced(false); }}>Today's note</button>
                  <button className="menu-item" onClick={() => { openRandomNote(); setShowAdvanced(false); }}>Random note</button>
                </div>
                <div className="menu-group">
                  <div className="menu-label">Tools</div>
                  <button className="menu-item" onClick={() => { setMultiMode((v) => !v); setSelectedIds(new Set()); setShowAdvanced(false); }}>{multiMode ? 'Stop selecting' : 'Select multiple'}</button>
                  <button className="menu-item" onClick={() => { setShowStats(true); setShowAdvanced(false); }}>Statistics</button>
                  <button className="menu-item" onClick={() => { setShowPomodoro(true); setShowAdvanced(false); }}>Focus timer</button>
                </div>
                {allTags.length > 0 && (
                  <div className="menu-group">
                    <div className="menu-label">Tags</div>
                    <div className="tag-cloud">
                      {allTags.map((t) => (
                        <button key={t} className="tag-chip" onClick={() => { setQuery(t); setShowAdvanced(false); }}>#{t}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="menu-group">
                  <div className="menu-label">Filter by color</div>
                  <div className="color-picker">
                    <button className={`color-dot ${!colorFilter ? 'active' : ''}`} style={{ background: 'transparent', border: '1px solid var(--border)' }} onClick={() => setColorFilter(null)} title="No filter" />
                    {NOTE_COLORS.map((c) => (
                      <button key={c} className={`color-dot ${colorFilter === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColorFilter(colorFilter === c ? null : c)} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
      )}

      <main className="editor">
        {view === 'calendar' ? (
          <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <button className="small-btn" onClick={() => setView('all')}>← Notes</button>
              <button className="small-btn" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>◀</button>
              <h2 style={{ margin: 0 }}>{calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</h2>
              <button className="small-btn" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>▶</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d) => <div key={d} style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{d}</div>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
              {(() => {
                const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
                const startDay = first.getDay();
                const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
                const cells = [];
                for (let i = 0; i < startDay; i++) cells.push(<div key={'e' + i} />);
                for (let d = 1; d <= daysInMonth; d++) {
                  const dayNotes = notes.filter((n) => {
                    const nd = new Date(n.createdAt);
                    return !n.trashed && nd.getFullYear() === calendarMonth.getFullYear() && nd.getMonth() === calendarMonth.getMonth() && nd.getDate() === d;
                  });
                  cells.push(
                    <div key={d} onClick={() => setCalendarDay(d)} style={{ minHeight: 60, border: '1px solid var(--border)', borderRadius: 6, padding: 4, background: calendarDay === d ? 'var(--active)' : 'var(--bg)', cursor: 'pointer' }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{d}</div>
                      {dayNotes.slice(0, 3).map((n) => (
                        <div key={n.id} onClick={(e) => { e.stopPropagation(); setSelectedId(n.id); setView('all'); }} style={{ fontSize: 10, color: 'var(--accent)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title || 'Untitled'}</div>
                      ))}
                      {dayNotes.length > 3 && <div style={{ fontSize: 9, color: 'var(--muted)' }}>+{dayNotes.length - 3}</div>}
                    </div>
                  );
                }
                return cells;
              })()}
            </div>
          </div>
        ) : view === 'graph' ? (
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            <canvas id="graphCanvas" width={800} height={600} style={{ width: '100%', height: '100%', background: 'var(--bg)' }} />
            <div style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
              <button className="small-btn" onClick={() => setView('all')}>← Notes</button>
              <span>Nodes: notes · Edges: [[wiki links]] · Click a node to open</span>
            </div>
          </div>
        ) : selected ? (
          <>
            <div className="editor-header">
              <input className="title-input" value={selected.title} onChange={(e) => updateNote(selected.id, { title: e.target.value })} placeholder="Untitled" />
              <div className="editor-actions">
                <button className={selected.favorite ? 'icon-action on' : 'icon-action'} onClick={() => updateNote(selected.id, { favorite: !selected.favorite })} title={selected.favorite ? 'Remove star' : 'Star'}>★</button>
                <button className={selected.pinned ? 'icon-action on' : 'icon-action'} onClick={() => updateNote(selected.id, { pinned: !selected.pinned })} title={selected.pinned ? 'Unpin' : 'Pin'}>📌</button>
                <button className="icon-action" onClick={() => setPreview((v) => !v)} title={preview ? 'Edit' : 'Preview'}>{preview ? '✎' : '👁'}</button>
                <button className="icon-action" title="Share live" onClick={() => { setCollabNote({ id: selected.id, title: selected.title, content: selected.content }); setMode('collab'); }}>🤝</button>
                <div style={{ position: 'relative' }}>
                  <button className={showMore ? 'icon-action on' : 'icon-action'} onClick={() => setShowMore((v) => !v)} title="More">⋯</button>
                  {showMore && (
                    <div className="more-menu">
                      <div className="menu-group">
                        <button className="menu-item" onClick={() => { duplicateNote(); setShowMore(false); }}>Duplicate</button>
                        <button className="menu-item" onClick={() => { updateNote(selected.id, { archived: !selected.archived }); setShowMore(false); }}>{selected.archived ? 'Unarchive' : 'Archive'}</button>
                        <button className="menu-item" onClick={() => { saveVersion(); setShowMore(false); }}>Save version</button>
                        {selected.history && selected.history.length > 0 && (
                          <select className="menu-select" value="" onChange={(e) => {
                            const i = Number(e.target.value);
                            e.target.value = '';
                            if (isNaN(i) || !confirm('Restore this version? Current content will be saved as a version.')) return;
                            const hist = [selected.content, ...selected.history!.filter((_, idx) => idx !== i)].slice(0, 10);
                            updateNote(selected.id, { content: selected.history![i], history: hist });
                          }}>
                            <option value="">Restore version…</option>
                            {selected.history.map((_h, i) => <option key={i} value={i}>Version {i + 1}</option>)}
                          </select>
                        )}
                      </div>

                      <div className="menu-group">
                        <div className="menu-label">Insert</div>
                        <select className="menu-select" value="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ''; }}>
                          <option value="">Template…</option>
                          <option value="meeting">Meeting notes</option>
                          <option value="journal">Daily journal</option>
                          <option value="project">Project plan</option>
                          <option value="book">Book notes</option>
                        </select>
                        <button className="menu-item" onClick={() => { addChecklist(); setShowMore(false); }}>☑ Checklist</button>
                      </div>

                      <div className="menu-group">
                        <div className="menu-label">Details</div>
                        <select className="menu-select" value={selected.folderId ?? ''} onChange={(e) => updateNote(selected.id, { folderId: e.target.value || null })}>
                          <option value="">No folder</option>
                          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        <div className="color-picker">
                          {NOTE_COLORS.map((c) => (
                            <button key={c} className={`color-dot ${selected.color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => updateNote(selected.id, { color: selected.color === c ? null : c })} />
                          ))}
                        </div>
                        <label className="menu-row">Reminder
                          <input type="datetime-local" value={selected.reminderAt ? new Date(selected.reminderAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''} onChange={(e) => {
                            const v = e.target.value;
                            updateNote(selected.id, { reminderAt: v ? new Date(v).getTime() : null });
                          }} />
                        </label>
                        <input className="menu-input" placeholder="Add tag, press Enter" onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const v = (e.target as HTMLInputElement).value.trim();
                            if (v && !selected.tags.includes(v)) updateNote(selected.id, { tags: [...selected.tags, v] });
                            (e.target as HTMLInputElement).value = '';
                          }
                        }} />
                      </div>

                      <div className="menu-group">
                        <div className="menu-label">Tools</div>
                        <button className="menu-item" onClick={() => { setAiOpen((v) => !v); setShowMore(false); }}>🤖 AI assistant</button>
                        <button className="menu-item" onClick={() => { startVoice(); setShowMore(false); }}>{listening ? '⏹ Stop voice' : '🎤 Voice input'}</button>
                        <button className="menu-item" onClick={() => { setCollabNote({ id: selected.id, title: selected.title, content: selected.content }); setMode('collab'); setShowMore(false); }}>🤝 Share this note live</button>
                        <button className="menu-item" onClick={() => { setFocusMode((v) => !v); setShowMore(false); }}>{focusMode ? 'Exit focus mode' : 'Focus mode'}</button>
                        <button className="menu-item" onClick={() => { if (selected.locked) unlockNote(); else lockNote(); setShowMore(false); }}>{selected.locked ? '🔓 Unlock' : '🔒 Lock'}</button>
                      </div>

                      <div className="menu-group">
                        <div className="menu-label">Export</div>
                        <button className="menu-item" onClick={() => { exportNote(selected); setShowMore(false); }}>Markdown file</button>
                        <button className="menu-item" onClick={() => { exportPDF(); setShowMore(false); }}>PDF</button>
                        <button className="menu-item" onClick={() => { window.print(); setShowMore(false); }}>Print</button>
                      </div>

                      <div className="menu-group">
                        {selected.trashed ? (
                          <>
                            <button className="menu-item" onClick={() => { restoreNote(selected.id); setShowMore(false); }}>Restore</button>
                            <button className="menu-item danger" onClick={() => { deleteForever(selected.id); setShowMore(false); }}>Delete forever</button>
                          </>
                        ) : (
                          <button className="menu-item danger" onClick={() => { trashNote(selected.id); setShowMore(false); }}>Move to trash</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {selected.tags.length > 0 && (
              <div className="tag-row">
                {selected.tags.map((t) => (
                  <span key={t} className="tag-chip editable" onClick={() => toggleTag(selected.id, t)}>#{t} ✕</span>
                ))}
              </div>
            )}

            {aiOpen && (
              <div className="ai-panel">
                <textarea className="ai-prompt" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="Describe what you want the AI to write..." />
                <div className="ai-actions">
                  <button onClick={() => runAI('You are a helpful note-writing assistant. Write a well-structured note in Markdown based on the user request.', aiPrompt || selected.title || 'a useful note')}>Write</button>
                  <button onClick={() => runAI('Expand the following note with more detail, keep Markdown format.', selected.content)}>Expand</button>
                  <button onClick={() => runAI('Summarize the following note concisely in Markdown.', selected.content)}>Summarize</button>
                  <button onClick={() => runAI('Fix grammar and spelling, keep meaning and Markdown.', selected.content)}>Fix grammar</button>
                  <button onClick={() => runAI('Continue writing the note naturally in Markdown.', selected.content)}>Continue</button>
                  <button onClick={() => runAI('Translate the following note to English, keep Markdown.', selected.content)}>Translate EN</button>
                </div>
                {aiLoading && <div className="ai-status">Thinking…</div>}
                {aiError && <div className="ai-error">{aiError}</div>}
                {aiResult && (
                  <div className="ai-result">
                    <pre>{aiResult}</pre>
                    <div className="ai-result-actions">
                      <button onClick={() => updateNote(selected.id, { content: selected.content + '\\n\\n' + aiResult })}>Append</button>
                      <button onClick={() => updateNote(selected.id, { content: aiResult })}>Replace</button>
                      <button onClick={() => setAiResult('')}>Clear</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {selected.locked ? (
              <div className="empty-state" style={{ flex: 1 }}>
                <h2>🔒 Note locked</h2>
                <p>This note is encrypted. Click Unlock and enter the password to view.</p>
                <button className="primary-btn" onClick={unlockNote}>Unlock</button>
              </div>
            ) : preview ? (
              <div className="markdown-preview" onClick={handlePreviewClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(selected.content) }} />
            ) : (
              <textarea className="content-input" style={{ fontSize: `${fontSize}px`, fontFamily: fontFamily === 'serif' ? 'Georgia, serif' : fontFamily === 'mono' ? 'Consolas, monospace' : fontFamily === 'sans' ? 'Helvetica, sans-serif' : 'inherit' }} value={selected.content} onChange={(e) => updateNote(selected.id, { content: e.target.value })} placeholder="Start writing... (Markdown supported)" />
            )}
            {backlinks.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                Backlinks: {backlinks.map((n) => <button key={n.id} onClick={() => setSelectedId(n.id)} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}>{n.title}</button>)}
              </div>
            )}
            {wordGoal > 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 0' }}>
                Goal: {selected.content.split(/\s+/).filter(Boolean).length}/{wordGoal} words
                <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginTop: 2 }}>
                  <div style={{ height: '100%', width: `${Math.min(100, (selected.content.split(/\s+/).filter(Boolean).length / wordGoal) * 100)}%`, background: 'var(--accent)', borderRadius: 2 }} />
                </div>
              </div>
            )}
            <div className="editor-footer">
              {selected.content.split(/\s+/).filter(Boolean).length} words · {selected.content.length} chars · ~{Math.max(1, Math.ceil(selected.content.split(/\s+/).filter(Boolean).length / 200))} min read · Updated {formatDate(selected.updatedAt)}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <h2>Select or create a note</h2>
            <p>Your notes are saved locally on this device.</p>
            <div className="empty-actions">
              <button className="primary-btn" onClick={() => createNote(null)}>+ New Note</button>
              <label className="primary-btn secondary">
                Import backup
                <input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importNotes(f); e.target.value = ''; }} />
              </label>
            </div>
          </div>
        )}
      </main>

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>
            <label>Theme
              <select value={theme} onChange={(e) => setTheme(e.target.value as any)}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label>Font size ({fontSize}px)
              <input type="range" min={12} max={24} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
            </label>
            <label>AI base URL
              <input type="text" value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </label>
            <label>AI API key
              <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="sk-..." />
            </label>
            <label>AI model
              <input type="text" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="gpt-4o-mini" />
            </label>
            <label>Backend URL (for signup/admin/sync)
              <input type="text" value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} placeholder="http://localhost:3000" />
            </label>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
              <strong style={{ fontSize: 13 }}>Cloud sync</strong>
              {syncToken ? (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0' }}>Logged in as {syncEmail}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Last sync: {lastSync || 'never'}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button onClick={() => doSync()}>Sync now</button>
                    <button onClick={syncLogout}>Log out</button>
                  </div>
                  <label style={{ marginTop: 6 }}>Auto-sync every 5 min
                    <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
                  </label>
                </>
              ) : (
                <>
                  <input type="text" placeholder="Name" value={syncNameInput} onChange={(e) => setSyncNameInput(e.target.value)} style={{ width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', marginBottom: 4 }} />
                  <input type="email" placeholder="Email" value={syncEmailInput} onChange={(e) => setSyncEmailInput(e.target.value)} style={{ width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', marginBottom: 4 }} />
                  <input type="password" placeholder="Password" value={syncPasswordInput} onChange={(e) => setSyncPasswordInput(e.target.value)} style={{ width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', marginBottom: 6 }} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={syncRegister}>Register</button>
                    <button onClick={syncLogin}>Login</button>
                  </div>
                </>
              )}
              {syncStatus && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{syncStatus}</div>}
            </div>
            <label>App lock password
              <button onClick={setAppLock}>Set / change / remove</button>
            </label>
            {appLockHash && (
              <label>Lock app now
                <button onClick={() => { setShowAppLock(true); }}>Lock</button>
              </label>
            )}
            <label>Launch at Windows startup
              <input type="checkbox" checked={autoLaunch} onChange={async (e) => {
                const v = e.target.checked;
                setAutoLaunch(v);
                await window.electronAPI?.setAutoLaunch(v);
              }} />
            </label>
            <label>Admin dashboard
              <button onClick={() => window.electronAPI?.openExternal(backendUrl.replace(/\/$/, '') + '/admin')}>Open admin dashboard</button>
            </label>
            <label>Font family
              <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}>
                <option value="system">System</option>
                <option value="serif">Serif</option>
                <option value="mono">Monospace</option>
                <option value="sans">Sans-serif</option>
              </select>
            </label>
            <label>Spell-check language
              <select onChange={(e) => window.electronAPI?.setSpellCheckerLanguages([e.target.value])} defaultValue="en-US">
                <option value="en-US">English (US)</option>
                <option value="en-GB">English (UK)</option>
                <option value="es-ES">Spanish</option>
                <option value="fr-FR">French</option>
                <option value="de-DE">German</option>
                <option value="it-IT">Italian</option>
                <option value="pt-BR">Portuguese (BR)</option>
              </select>
            </label>
            <label>Word count goal (0 = off)
              <input type="number" min={0} value={wordGoal} onChange={(e) => setWordGoal(Number(e.target.value) || 0)} />
            </label>
            <label>Compact sidebar
              <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
            </label>
            <label>Export all notes as Markdown (zip)
              <button onClick={exportMarkdownZip}>Export .md zip</button>
            </label>
            <label>Import Markdown files
              <input type="file" accept=".md,.txt" multiple onChange={(e) => { if (e.target.files) importMarkdownFiles(e.target.files); e.target.value = ''; }} />
            </label>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
              <strong style={{ fontSize: 13 }}>Real-time collaboration</strong>
              {collabConnected ? (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0' }}>Room: {collabRoom} · {collabStatus}</div>
                  <button onClick={stopCollab}>Stop collaborating</button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0' }}>Share current note or join a room</div>
                  <button onClick={() => selected && startCollab(selected.id)}>Share current note</button>
                  <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    <input type="text" placeholder="Room code" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} style={{ flex: 1, padding: 6, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }} />
                    <button onClick={joinCollab}>Join</button>
                  </div>
                </>
              )}
              {collabStatus && !collabConnected && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{collabStatus}</div>}
            </div>
            <label>About
              <button onClick={() => setShowAbout(true)}>About Notes</button>
            </label>
            <label>Reset signup prompt
              <button onClick={() => { localStorage.removeItem('notes-app:signupDone'); setShowWelcome(true); }}>Reset</button>
            </label>
            <p className="hint">Works with OpenAI or any OpenAI-compatible API (Azure, LM Studio, Ollama). Keys are stored locally.</p>
            <label>Export all notes (JSON backup)
              <button onClick={exportAll}>Export backup</button>
            </label>
            <label>Import backup
              <input type="file" accept=".json" onChange={(e) => { const f = e.target.files?.[0]; if (f) importNotes(f); e.target.value = ''; }} />
            </label>
            <button className="primary-btn" onClick={() => setShowSettings(false)}>Close</button>
          </div>
        </div>
      )}

      {showPalette && (
        <div className="modal-overlay" onClick={() => setShowPalette(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
            <input className="search" autoFocus placeholder="Type a command or note title..." value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)} />
            <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              {(() => {
                const q = paletteQuery.toLowerCase();
                const actions = [
                  { label: 'New note', run: () => createNote(null) },
                  { label: 'Toggle theme', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
                  { label: 'Toggle preview', run: () => setPreview((v) => !v) },
                  { label: 'Open settings', run: () => setShowSettings(true) },
                  { label: 'Export backup', run: () => exportAll() },
                ].filter((a) => a.label.toLowerCase().includes(q));
                const notesMatch = notes.filter((n) => !n.trashed && (n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))).slice(0, 8);
                return (
                  <>
                    {actions.map((a) => (
                      <button key={a.label} className="nav-item" onClick={() => { a.run(); setShowPalette(false); setPaletteQuery(''); }}>{a.label}</button>
                    ))}
                    {notesMatch.length > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, textTransform: 'uppercase' }}>Notes</div>}
                    {notesMatch.map((n) => (
                      <button key={n.id} className="nav-item" onClick={() => { setSelectedId(n.id); setShowPalette(false); setPaletteQuery(''); }}>{n.title || 'Untitled'}</button>
                    ))}
                    {actions.length === 0 && notesMatch.length === 0 && <div className="empty">No matches</div>}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {showAppLock && (
        <div className="modal-overlay" style={{ zIndex: 200 }}>
          <div className="modal">
            <h2>🔒 App locked</h2>
            <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0 }}>Enter your password to continue.</p>
            <input type="password" value={lockInput} onChange={(e) => setLockInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && tryAppUnlock()} placeholder="Password" style={{ width: '100%', padding: 8, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }} />
            {lockError && <div className="ai-error">{lockError}</div>}
            <button className="primary-btn" onClick={tryAppUnlock}>Unlock</button>
          </div>
        </div>
      )}

      {updateVersion && (
        <div style={{ position: 'fixed', bottom: 16, right: 16, background: 'var(--accent)', color: 'white', padding: '10px 16px', borderRadius: 8, zIndex: 300, boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
          Update {updateVersion} available. Restart to install.
          <button style={{ marginLeft: 8, background: 'transparent', border: '1px solid white', color: 'white', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }} onClick={() => setUpdateVersion('')}>Dismiss</button>
        </div>
      )}

      {showStats && (
        <div className="modal-overlay" onClick={() => setShowStats(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
            <h2>Statistics</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 14 }}>
              <div>Notes: <strong>{notes.filter((n) => !n.trashed).length}</strong></div>
              <div>Trashed: <strong>{notes.filter((n) => n.trashed).length}</strong></div>
              <div>Folders: <strong>{folders.length}</strong></div>
              <div>Tags: <strong>{new Set(notes.flatMap((n) => n.tags)).size}</strong></div>
              <div>Total words: <strong>{notes.filter((n) => !n.trashed).reduce((a, n) => a + n.content.split(/\s+/).filter(Boolean).length, 0)}</strong></div>
              <div>Pinned: <strong>{notes.filter((n) => n.pinned && !n.trashed).length}</strong></div>
              <div>Favorites: <strong>{notes.filter((n) => n.favorite && !n.trashed).length}</strong></div>
              <div>Locked: <strong>{notes.filter((n) => n.locked).length}</strong></div>
            </div>
            <button className="primary-btn" onClick={() => setShowStats(false)} style={{ marginTop: 12 }}>Close</button>
          </div>
        </div>
      )}

      {showPomodoro && (
        <div className="modal-overlay" onClick={() => setShowPomodoro(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>⏱ Pomodoro</h2>
            <div style={{ fontSize: 48, textAlign: 'center', fontWeight: 700, margin: '12px 0' }}>
              {String(Math.floor(pomoSeconds / 60)).padStart(2, '0')}:{String(pomoSeconds % 60).padStart(2, '0')}
            </div>
            <div style={{ textAlign: 'center', color: 'var(--muted)', marginBottom: 12 }}>{pomoMode === 'work' ? 'Work session' : 'Break'}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="primary-btn" onClick={() => setPomoRunning((r) => !r)}>{pomoRunning ? 'Pause' : 'Start'}</button>
              <button className="primary-btn secondary" onClick={() => { setPomoRunning(false); setPomoMode('work'); setPomoSeconds(25 * 60); }}>Reset</button>
              <button className="primary-btn secondary" onClick={() => { setPomoRunning(false); if (pomoMode === 'work') { setPomoMode('break'); setPomoSeconds(5 * 60); } else { setPomoMode('work'); setPomoSeconds(25 * 60); } }}>Switch</button>
            </div>
            <button className="primary-btn" onClick={() => setShowPomodoro(false)} style={{ marginTop: 12 }}>Close</button>
          </div>
        </div>
      )}

      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
        ))}
      </div>

      {showAbout && (
        <div className="modal-overlay" onClick={() => setShowAbout(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Notes</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
              Version 1.0.0<br />
              A simple, fast, offline-first notes app for Windows.<br /><br />
              Built with Electron + React + TypeScript.<br />
              Includes Story Writer, Secret Diary, and Code Editor modes.<br /><br />
              © 2026 Yasin Kik. MIT License.
            </p>
            <button className="primary-btn" onClick={() => setShowAbout(false)}>Close</button>
          </div>
        </div>
      )}

      {showWelcome && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Welcome to Notes 👋</h2>
            <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0 }}>
              Optionally create an account so the developer can see usage. You can skip this — the app works fully offline.
            </p>
            <label>Name
              <input type="text" value={signupName} onChange={(e) => setSignupName(e.target.value)} placeholder="Your name" />
            </label>
            <label>Email
              <input type="email" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {signupStatus && <div className="ai-error">{signupStatus}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary-btn" onClick={doSignup}>Sign up</button>
              <button className="primary-btn secondary" onClick={skipSignup}>Skip</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
