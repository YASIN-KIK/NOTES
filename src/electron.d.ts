export {};

declare global {
  interface Window {
    electronAPI?: {
      aiChat: (payload: {
        baseUrl: string;
        apiKey: string;
        model: string;
        messages: { role: string; content: string }[];
      }) => Promise<{ ok: boolean; content?: string; error?: string }>;
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      setAutoLaunch: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      getAutoLaunch: () => Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
      printToPDF: (html: string) => Promise<{ ok: boolean; data?: number[]; error?: string }>;
      setSpellCheckerLanguages: (langs: string[]) => Promise<{ ok: boolean; error?: string }>;
      onQuickCapture: (cb: () => void) => () => void;
      onUpdateAvailable: (cb: (version: string) => void) => () => void;
      onCollabJoin: (cb: (code: string) => void) => () => void;
    };
  }
}
