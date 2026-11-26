import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import './App.css';

type File = { id: string; name: string; lang: string; content: string };

const STORAGE_KEY = 'code-editor:files';

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function loadFiles(): File[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [{ id: uid(), name: 'main.js', lang: 'javascript', content: '// Welcome to Code mode\nconsole.log("Hello, world!");\n' }];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : [{ id: uid(), name: 'main.js', lang: 'javascript', content: '' }];
  } catch { return [{ id: uid(), name: 'main.js', lang: 'javascript', content: '' }]; }
}

const LANGS: { id: string; label: string; ext: string }[] = [
  { id: 'javascript', label: 'JavaScript', ext: 'js' },
  { id: 'python', label: 'Python', ext: 'py' },
  { id: 'html', label: 'HTML', ext: 'html' },
  { id: 'css', label: 'CSS', ext: 'css' },
  { id: 'markdown', label: 'Markdown', ext: 'md' },
];

function langExtension(lang: string) {
  switch (lang) {
    case 'javascript': return javascript();
    case 'python': return python();
    case 'html': return html();
    case 'css': return css();
    case 'markdown': return markdown();
    default: return javascript();
  }
}

export default function CodeEditor() {
  const [files, setFiles] = useState<File[]>(() => loadFiles());
  const [activeId, setActiveId] = useState<string>(() => loadFiles()[0]?.id || '');
  const [output, setOutput] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(files)); }, [files]);

  const active = files.find((f) => f.id === activeId) || files[0];

  const updateFile = (id: string, content: string) => {
    setFiles((prev) => prev.map((f) => f.id === id ? { ...f, content } : f));
  };

  const addFile = () => {
    const lang = 'javascript';
    const f: File = { id: uid(), name: `file${files.length + 1}.js`, lang, content: '' };
    setFiles((prev) => [...prev, f]);
    setActiveId(f.id);
  };

  const deleteFile = (id: string) => {
    if (files.length <= 1) return;
    const remaining = files.filter((f) => f.id !== id);
    setFiles(remaining);
    if (activeId === id) setActiveId(remaining[0].id);
  };

  const renameFile = (id: string, name: string) => {
    setFiles((prev) => prev.map((f) => f.id === id ? { ...f, name } : f));
  };

  const changeLang = (id: string, lang: string) => {
    const ext = LANGS.find((l) => l.id === lang)?.ext || 'txt';
    setFiles((prev) => prev.map((f) => f.id === id ? { ...f, lang, name: f.name.replace(/\.[^.]+$/, '.' + ext) } : f));
  };

  const runCode = () => {
    if (!active) return;
    setOutput('');
    if (active.lang === 'javascript') {
      const logs: string[] = [];
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args) => logs.push(args.map(String).join(' '));
      console.error = (...args) => logs.push('ERROR: ' + args.map(String).join(' '));
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(active.content);
        fn();
        setOutput(logs.join('\n') || '(no output)');
      } catch (e: any) {
        setOutput('Error: ' + (e?.message || String(e)));
      } finally {
        console.log = origLog;
        console.error = origError;
      }
    } else if (active.lang === 'python') {
      setOutput('Python execution requires a backend. Use the JS runner or install Pyodide. (Not included in this build.)');
    } else if (active.lang === 'html') {
      const w = window.open('', '_blank');
      if (w) { w.document.write(active.content); w.document.close(); }
      setOutput('Opened HTML in new window.');
    } else {
      setOutput('Run not supported for this language. Use JavaScript to execute.');
    }
  };

  return (
    <div className="app" style={{ fontSize: '14px' }}>
      <aside className="sidebar" style={{ width: 220 }}>
        <div className="sidebar-header"><h1>💻 Code</h1></div>
        <button className="primary-btn" onClick={addFile}>+ New File</button>
        <ul className="note-list">
          {files.map((f) => (
            <li key={f.id} className={f.id === activeId ? 'active' : ''} onClick={() => setActiveId(f.id)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ flex: 1, fontSize: 13 }}>{f.name}</span>
              {files.length > 1 && <button className="icon-btn tiny" onClick={(e) => { e.stopPropagation(); deleteFile(f.id); }}>✕</button>}
            </li>
          ))}
        </ul>
        {active && (
          <div style={{ padding: 8, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input value={active.name} onChange={(e) => renameFile(active.id, e.target.value)} style={{ padding: 4, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
            <select value={active.lang} onChange={(e) => changeLang(active.id, e.target.value)} style={{ padding: 4, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }}>
              {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <button className="primary-btn" onClick={runCode} style={{ padding: '6px 10px', fontSize: 12 }}>▶ Run</button>
            <button className="small-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀ Light' : '☾ Dark'}</button>
          </div>
        )}
      </aside>
      <main className="editor" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
        {active && (
          <>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <CodeMirror
                value={active.content}
                height="100%"
                theme={theme === 'dark' ? oneDark : 'light'}
                extensions={[langExtension(active.lang)]}
                onChange={(v) => updateFile(active.id, v)}
                basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true }}
              />
            </div>
            <div style={{ height: 160, borderTop: '1px solid var(--border)', padding: 8, overflow: 'auto', background: 'var(--bg)', fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
              <strong>Output:</strong>
              <div>{output || '(run code to see output)'}</div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
