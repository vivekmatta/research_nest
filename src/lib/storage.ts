import type { ResearchSession, SessionDetectionState, UserSettings } from "../types/index.js";

const KEYS = {
  SESSIONS: "rn_sessions",
  DETECTION: "rn_detection",
  SETTINGS: "rn_settings",
} as const;

const DEFAULT_SETTINGS: UserSettings = {
  aiEnabled: false,
  autoDetectEnabled: true,
  detectionThreshold: 8,
  detectionWindowMinutes: 5,
  theme: "system",
};

// ── Sessions ────────────────────────────────────────────────────────────────

export async function getSessions(): Promise<ResearchSession[]> {
  const result = await chrome.storage.local.get(KEYS.SESSIONS);
  return (result[KEYS.SESSIONS] as ResearchSession[]) ?? [];
}

export async function getSession(sessionId: string): Promise<ResearchSession | undefined> {
  const sessions = await getSessions();
  return sessions.find((s) => s.sessionId === sessionId);
}

export async function saveSession(session: ResearchSession): Promise<void> {
  const sessions = await getSessions();
  const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  await chrome.storage.local.set({ [KEYS.SESSIONS]: sessions });
  await checkStorageQuota();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const sessions = await getSessions();
  await chrome.storage.local.set({
    [KEYS.SESSIONS]: sessions.filter((s) => s.sessionId !== sessionId),
  });
}

// Strip embeddings from all tabs in a session to reclaim storage
export async function stripEmbeddings(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  session.tabs = session.tabs.map((t) => {
    const { embedding: _e, tfidfVector: _tf, ...rest } = t;
    return rest;
  });
  await saveSession(session);
}

// ── Detection State ──────────────────────────────────────────────────────────

const DEFAULT_DETECTION: SessionDetectionState = {
  recentTabEvents: [],
};

export async function getDetectionState(): Promise<SessionDetectionState> {
  const result = await chrome.storage.session.get(KEYS.DETECTION);
  return (result[KEYS.DETECTION] as SessionDetectionState) ?? DEFAULT_DETECTION;
}

export async function saveDetectionState(state: SessionDetectionState): Promise<void> {
  await chrome.storage.session.set({ [KEYS.DETECTION]: state });
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(result[KEYS.SETTINGS] as Partial<UserSettings>) };
}

export async function saveSettings(settings: Partial<UserSettings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ [KEYS.SETTINGS]: { ...current, ...settings } });
}

// ── API Key (XOR obfuscation) ─────────────────────────────────────────────────

const XOR_KEY = 0x5a;

export function obfuscateKey(key: string): string {
  return Array.from(key)
    .map((c) => (c.charCodeAt(0) ^ XOR_KEY).toString(16).padStart(2, "0"))
    .join("");
}

export function deobfuscateKey(hex: string): string {
  const result: string[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    result.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ XOR_KEY));
  }
  return result.join("");
}

export async function getGeminiKey(): Promise<string | null> {
  const settings = await getSettings();
  if (!settings.geminiKey) return null;
  return deobfuscateKey(settings.geminiKey);
}

export async function saveGeminiKey(plainKey: string): Promise<void> {
  await saveSettings({ geminiKey: obfuscateKey(plainKey) });
}

// ── Storage Quota Check ───────────────────────────────────────────────────────

async function checkStorageQuota(): Promise<void> {
  const bytesInUse = await chrome.storage.local.getBytesInUse(null);
  const WARN_THRESHOLD = 8 * 1024 * 1024; // 8MB
  if (bytesInUse > WARN_THRESHOLD) {
    chrome.notifications.create("storage-warning", {
      type: "basic",
      iconUrl: "../icons/icon48.png",
      title: "ResearchNest: Storage Warning",
      message: `Storage usage (${Math.round(bytesInUse / 1024 / 1024)}MB) is approaching the 10MB limit. Consider exporting and deleting old sessions.`,
    });
  }
}
