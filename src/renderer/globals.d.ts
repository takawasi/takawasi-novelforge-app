// Global type declarations for the renderer process
// window.takawasi is injected by contextBridge in preload/index.ts

interface NovelDocSummary {
  doc_id: string;
  title: string;
  beat_count: number;
  preview: string;
  updated_at: string;
}

interface SeriesMetadata {
  series_id: string;
  title: string;
  created_at: string;
}

interface NovelForgeApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

interface TakawasiAPI {
  auth: {
    check: () => Promise<{ loggedIn: boolean }>;
    login: () => Promise<{ ok: boolean }>;
    logout: () => Promise<{ ok: boolean }>;
    onCompleted: (cb: (data: { loggedIn: boolean }) => void) => void;
  };
  tba: {
    start: (id: string, message: string) => Promise<{ ok: boolean; error?: string }>;
    cancel: (id: string) => Promise<{ ok: boolean }>;
    onChunk: (id: string, cb: (chunk: string) => void) => void;
    onError: (id: string, cb: (data: { status?: number; message: string }) => void) => void;
    onEnd: (id: string, cb: () => void) => void;
    removeListeners: (id: string) => void;
  };
  terminal: {
    create: (id: string) => Promise<{ ok: boolean; error?: string }>;
    write: (id: string, data: string) => Promise<{ ok: boolean }>;
    resize: (id: string, cols: number, rows: number) => Promise<{ ok: boolean }>;
    destroy: (id: string) => Promise<{ ok: boolean }>;
    onData: (id: string, cb: (data: string) => void) => void;
    onExit: (id: string, cb: () => void) => void;
    removeListeners: (id: string) => void;
  };
  novelforge: {
    listDocs: () => Promise<NovelForgeApiResponse<{ docs: NovelDocSummary[] }>>;
    listSeries: () => Promise<NovelForgeApiResponse<{ series: SeriesMetadata[] }>>;
    createSeries: (title: string) => Promise<NovelForgeApiResponse<{ series_id: string }>>;
    listBySeries: (seriesId: string) => Promise<NovelForgeApiResponse<{ docs: NovelDocSummary[] }>>;
    newDoc: (title: string) => Promise<NovelForgeApiResponse<{ doc_id: string }>>;
  };
  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean }>;
  };
}

interface Window {
  takawasi: TakawasiAPI;
}
