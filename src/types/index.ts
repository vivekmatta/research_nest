export interface TabData {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  metaDescription: string;
  headings: string[];        // h1–h3 text, max 15
  bodySnippet: string;       // first ~600 chars of main content
  capturedAt: number;        // ms timestamp
  dwellTimeMs?: number;      // time user spent on this tab
  summaryBullets?: string[]; // 3–5 bullets, generated on demand
  embedding?: number[];      // 768-dim Gemini vector (deletable after clustering)
  tfidfVector?: Record<string, number>;
  captureFailed?: boolean;   // true if content script couldn't run (PDF, chrome://, etc.)
  isDuplicate?: boolean;
}

export interface Cluster {
  clusterId: string;
  label: string;             // top 2–3 keywords, e.g. "machine-learning neural"
  color: "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "grey";
  tabIds: number[];
  keywords: string[];        // top 5 keywords
  readingOrder?: number[];   // suggested reading order indices (indices into tabIds)
}

export interface ResearchSession {
  sessionId: string;
  title: string;             // editable; defaults to dominant cluster keyword
  createdAt: number;
  endedAt?: number;
  windowId: number;
  tabs: TabData[];
  clusters: Cluster[];
  summary?: string;
  takeaways?: string[];
  openQuestions?: string[];
  aiEnabled: boolean;        // snapshot of AI setting at session creation
}

export interface SessionDetectionState {
  recentTabEvents: { tabId: number; timestamp: number; windowId: number }[];
  sessionPromptedAt?: number;
  activeSessionId?: string;
}

export interface UserSettings {
  geminiKey?: string;              // XOR-obfuscated
  aiEnabled: boolean;
  autoDetectEnabled: boolean;
  detectionThreshold: number;     // default 8
  detectionWindowMinutes: number; // default 5
  theme: "light" | "dark" | "system";
}

export interface ContentScriptMessage {
  type: "PAGE_CONTENT";
  payload: {
    title: string;
    metaDescription: string;
    headings: string[];
    bodySnippet: string;
  };
}

export type ClusterColor = Cluster["color"];
export const CLUSTER_COLORS: ClusterColor[] = [
  "blue", "red", "yellow", "green", "pink", "purple", "cyan", "grey"
];
