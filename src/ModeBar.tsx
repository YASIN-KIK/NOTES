export type AppMode = 'notes' | 'story' | 'secret' | 'code' | 'collab';

const MODES: { id: AppMode; label: string; icon: string }[] = [
  { id: 'notes', label: 'Notes', icon: '📝' },
  { id: 'story', label: 'Story', icon: '📖' },
  { id: 'secret', label: 'Diary', icon: '🌙' },
  { id: 'code', label: 'Code', icon: '💻' },
  { id: 'collab', label: 'Live', icon: '🤝' },
];

export function ModeBar({ mode, onChange, compact }: { mode: AppMode; onChange: (m: AppMode) => void; compact?: boolean }) {
  if (compact) {
    return (
      <div className="mode-switch">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => onChange(m.id)}
            className={mode === m.id ? 'active' : ''}
            title={m.label}
          >
            {m.icon}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mode-bar">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          className={mode === m.id ? 'active' : ''}
        >
          {m.icon} {m.label}
        </button>
      ))}
    </div>
  );
}
