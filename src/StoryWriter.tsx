import { useEffect, useState } from 'react';
import './App.css';

type Chapter = { id: string; title: string; content: string };
type Story = {
  id: string;
  title: string;
  description: string;
  chapters: Chapter[];
  characters: string;
  outline: string;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = 'story-writer:stories';

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function loadStories(): Story[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export default function StoryWriter() {
  const [stories, setStories] = useState<Story[]>(() => loadStories());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [tab, setTab] = useState<'write' | 'characters' | 'outline'>('write');
  const [focusMode, setFocusMode] = useState(false);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(stories)); }, [stories]);

  const selected = stories.find((s) => s.id === selectedId) || null;
  const chapter = selected?.chapters.find((c) => c.id === chapterId) || null;

  const createStory = () => {
    const s: Story = {
      id: uid(), title: 'Untitled Story', description: '', chapters: [{ id: uid(), title: 'Chapter 1', content: '' }],
      characters: '', outline: '', createdAt: Date.now(), updatedAt: Date.now(),
    };
    setStories((prev) => [s, ...prev]);
    setSelectedId(s.id);
    setChapterId(s.chapters[0].id);
  };

  const updateStory = (id: string, patch: Partial<Story>) => {
    setStories((prev) => prev.map((s) => s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s));
  };

  const addChapter = () => {
    if (!selected) return;
    const c: Chapter = { id: uid(), title: `Chapter ${selected.chapters.length + 1}`, content: '' };
    updateStory(selected.id, { chapters: [...selected.chapters, c] });
    setChapterId(c.id);
  };

  const updateChapter = (cid: string, patch: Partial<Chapter>) => {
    if (!selected) return;
    updateStory(selected.id, { chapters: selected.chapters.map((c) => c.id === cid ? { ...c, ...patch } : c) });
  };

  const deleteChapter = (cid: string) => {
    if (!selected || selected.chapters.length <= 1) return;
    const remaining = selected.chapters.filter((c) => c.id !== cid);
    updateStory(selected.id, { chapters: remaining });
    setChapterId(remaining[0].id);
  };

  const totalWords = selected ? selected.chapters.reduce((a, c) => a + c.content.split(/\s+/).filter(Boolean).length, 0) : 0;

  return (
    <div className="app" style={{ fontSize: '16px' }}>
      {!focusMode && (
        <aside className="sidebar">
          <div className="sidebar-header"><h1>Stories</h1></div>
          <button className="primary-btn" onClick={createStory}>+ New Story</button>
          <ul className="note-list">
            {stories.length === 0 && <li className="empty">No stories yet</li>}
            {stories.map((s) => (
              <li key={s.id} className={s.id === selectedId ? 'active' : ''} onClick={() => { setSelectedId(s.id); setChapterId(s.chapters[0]?.id || null); }}>
                <div className="note-title">{s.title}</div>
                <div className="note-preview">{s.chapters.length} chapters · {s.chapters.reduce((a, c) => a + c.content.split(/\s+/).filter(Boolean).length, 0)} words</div>
              </li>
            ))}
          </ul>
        </aside>
      )}
      <main className="editor">
        {selected ? (
          <>
            <div className="editor-header">
              <input className="title-input" value={selected.title} onChange={(e) => updateStory(selected.id, { title: e.target.value })} placeholder="Story title" />
              <div className="editor-actions">
                <button onClick={() => setFocusMode((v) => !v)}>{focusMode ? 'Exit focus' : 'Focus'}</button>
                <button onClick={addChapter}>+ Chapter</button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
              {selected.chapters.map((c) => (
                <button key={c.id} onClick={() => setChapterId(c.id)} style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, background: chapterId === c.id ? 'var(--accent)' : 'var(--bg)', color: chapterId === c.id ? 'white' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                  {c.title}
                </button>
              ))}
              {chapter && selected.chapters.length > 1 && (
                <button onClick={() => deleteChapter(chapter.id)} style={{ padding: '4px 8px', border: '1px solid var(--danger)', borderRadius: 6, background: 'transparent', color: 'var(--danger)', cursor: 'pointer', fontSize: 12 }}>✕</button>
              )}
            </div>
            {chapter && (
              <>
                <input className="title-input" style={{ fontSize: 16, marginBottom: 8 }} value={chapter.title} onChange={(e) => updateChapter(chapter.id, { title: e.target.value })} placeholder="Chapter title" />
                <textarea className="content-input" value={chapter.content} onChange={(e) => updateChapter(chapter.id, { content: e.target.value })} placeholder="Write your story..." style={{ fontFamily: 'Georgia, serif', lineHeight: 1.8 }} />
                <div className="editor-footer">
                  {chapter.content.split(/\s+/).filter(Boolean).length} words this chapter · {totalWords} words total
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
              <button className={`nav-item ${tab === 'write' ? 'active' : ''}`} onClick={() => setTab('write')}>Write</button>
              <button className={`nav-item ${tab === 'characters' ? 'active' : ''}`} onClick={() => setTab('characters')}>Characters</button>
              <button className={`nav-item ${tab === 'outline' ? 'active' : ''}`} onClick={() => setTab('outline')}>Outline</button>
            </div>
            {tab === 'characters' && (
              <textarea className="content-input" style={{ minHeight: 120, marginTop: 8 }} value={selected.characters} onChange={(e) => updateStory(selected.id, { characters: e.target.value })} placeholder="Character descriptions..." />
            )}
            {tab === 'outline' && (
              <textarea className="content-input" style={{ minHeight: 120, marginTop: 8 }} value={selected.outline} onChange={(e) => updateStory(selected.id, { outline: e.target.value })} placeholder="Plot outline..." />
            )}
          </>
        ) : (
          <div className="empty-state">
            <h2>Story Writer</h2>
            <p>Create a story to begin writing.</p>
            <button className="primary-btn" onClick={createStory}>+ New Story</button>
          </div>
        )}
      </main>
    </div>
  );
}
