// ResearchNest background service worker — MV3

import * as storage from "../lib/storage.js";
import { buildCorpusTFIDF } from "../lib/tfidf.js";
import { clusterTabs, autoNameSession, findDuplicates } from "../lib/clustering.js";
import { batchEmbeddings } from "../lib/embeddings.js";
import { createTabGroups } from "../lib/tab-groups.js";
import type {
  TabData,
  ResearchSession,
  SessionDetectionState,
  ContentScriptMessage,
} from "../types/index.js";

// ── Dwell time tracking ───────────────────────────────────────────────────────

let _activeTabId: number | null = null;
let _activeStartTime: number | null = null;
// In-memory dwell accumulator — persisted on tab remove / session end
const _dwellMap = new Map<number, number>();

function recordDwell(tabId: number | null): void {
  if (tabId === null || _activeStartTime === null) return;
  const elapsed = Date.now() - _activeStartTime;
  _dwellMap.set(tabId, (_dwellMap.get(tabId) ?? 0) + elapsed);
}

// ── Tab event handlers ────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  recordDwell(_activeTabId);
  _activeTabId = tabId;
  _activeStartTime = Date.now();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;

  const settings = await storage.getSettings();
  if (!settings.autoDetectEnabled) return;

  const state = await storage.getDetectionState();

  // Don't record system tabs
  if (isSystemTab(tab.url ?? "")) return;

  state.recentTabEvents.push({
    tabId: tab.id,
    timestamp: Date.now(),
    windowId: tab.windowId,
  });

  await storage.saveDetectionState(state);
  await checkForSessionTrigger(state);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Persist dwell time
  if (tabId === _activeTabId) {
    recordDwell(_activeTabId);
    _activeTabId = null;
    _activeStartTime = null;
  }

  const state = await storage.getDetectionState();
  if (!state.activeSessionId) return;

  const session = await storage.getSession(state.activeSessionId);
  if (!session) return;

  const tab = session.tabs.find((t) => t.tabId === tabId);
  if (tab) {
    tab.dwellTimeMs = (_dwellMap.get(tabId) ?? 0);
    _dwellMap.delete(tabId);
    await storage.saveSession(session);
  }
});

// ── Content script messages ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ContentScriptMessage, sender) => {
    if (message.type !== "PAGE_CONTENT") return;
    if (!sender.tab?.id) return;

    void handlePageContent(sender.tab.id, sender.tab.windowId ?? 0, message.payload);
  }
);

async function handlePageContent(
  tabId: number,
  windowId: number,
  payload: ContentScriptMessage["payload"]
): Promise<void> {
  const state = await storage.getDetectionState();
  if (!state.activeSessionId) return;

  const session = await storage.getSession(state.activeSessionId);
  if (!session) return;

  const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
  if (!tabInfo) return;

  // Update or add tab data
  const existing = session.tabs.findIndex((t) => t.tabId === tabId);
  const tabData: TabData = {
    tabId,
    windowId,
    url: tabInfo.url ?? "",
    title: payload.title || tabInfo.title || tabInfo.url || "",
    metaDescription: payload.metaDescription,
    headings: payload.headings,
    bodySnippet: payload.bodySnippet,
    capturedAt: Date.now(),
  };

  if (existing >= 0) {
    session.tabs[existing] = { ...session.tabs[existing], ...tabData };
  } else {
    session.tabs.push(tabData);
  }

  await storage.saveSession(session);
}

// ── Keyboard commands ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open-dashboard") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  } else if (command === "export-session") {
    const state = await storage.getDetectionState();
    if (state.activeSessionId) {
      chrome.runtime.sendMessage({ type: "EXPORT_SESSION", sessionId: state.activeSessionId }).catch(() => {});
    }
  }
});

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.create("prune-window", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "prune-window") {
    await pruneOldTabEvents();
  }
});

async function pruneOldTabEvents(): Promise<void> {
  const settings = await storage.getSettings();
  const state = await storage.getDetectionState();
  const windowMs = settings.detectionWindowMinutes * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  state.recentTabEvents = state.recentTabEvents.filter(
    (e) => e.timestamp > cutoff
  );
  await storage.saveDetectionState(state);
}

// ── Session detection ─────────────────────────────────────────────────────────

async function checkForSessionTrigger(
  state: SessionDetectionState
): Promise<void> {
  const settings = await storage.getSettings();
  if (!settings.autoDetectEnabled) return;
  if (state.activeSessionId) return;

  // Already prompted recently (within 2 min)
  if (state.sessionPromptedAt && Date.now() - state.sessionPromptedAt < 120_000) {
    return;
  }

  const windowMs = settings.detectionWindowMinutes * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const recent = state.recentTabEvents.filter((e) => e.timestamp > cutoff);

  if (recent.length < settings.detectionThreshold) return;

  // Trigger notification
  state.sessionPromptedAt = Date.now();
  await storage.saveDetectionState(state);

  chrome.notifications.create("session-detected", {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "ResearchNest: Research session detected!",
    message: `You've opened ${recent.length} tabs in ${settings.detectionWindowMinutes} minutes. Start a session?`,
    buttons: [{ title: "Start Session" }, { title: "Dismiss" }],
    requireInteraction: true,
  });
}

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (notifId !== "session-detected") return;
  chrome.notifications.clear(notifId);
  if (btnIdx === 0) {
    await startSession();
  }
});

// ── Session lifecycle ─────────────────────────────────────────────────────────

export async function startSession(): Promise<string> {
  const state = await storage.getDetectionState();
  if (state.activeSessionId) return state.activeSessionId;

  const [currentWindow] = await chrome.windows.getAll({ populate: false });
  const windowId = currentWindow?.id ?? 0;

  // Gather all open non-system tabs in the current window
  const tabs = await chrome.tabs.query({ windowId });
  const validTabs = tabs.filter((t) => t.url && !isSystemTab(t.url));

  const tabDataList: TabData[] = validTabs.map((t) => ({
    tabId: t.id!,
    windowId: t.windowId,
    url: t.url ?? "",
    title: t.title ?? t.url ?? "",
    metaDescription: "",
    headings: [],
    bodySnippet: "",
    capturedAt: Date.now(),
  }));

  const session: ResearchSession = {
    sessionId: crypto.randomUUID(),
    title: `Session ${new Date().toLocaleDateString()}`,
    createdAt: Date.now(),
    windowId,
    tabs: tabDataList,
    clusters: [],
    aiEnabled: (await storage.getSettings()).aiEnabled,
  };

  await storage.saveSession(session);

  state.activeSessionId = session.sessionId;
  await storage.saveDetectionState(state);

  // Inject content scripts into existing tabs
  for (const tab of validTabs) {
    if (!tab.id || !tab.url || isSystemTab(tab.url)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/content-script.js"],
      });
    } catch {
      // Tab may not be injectable (PDF, etc.) — mark capture failed
      const tabIdx = session.tabs.findIndex((td) => td.tabId === tab.id);
      if (tabIdx >= 0) session.tabs[tabIdx].captureFailed = true;
    }
  }
  await storage.saveSession(session);

  // Notify popup/dashboard of session start
  chrome.runtime.sendMessage({ type: "SESSION_STARTED", sessionId: session.sessionId }).catch(() => {});

  return session.sessionId;
}

export async function endSession(sessionId: string): Promise<void> {
  const session = await storage.getSession(sessionId);
  if (!session) return;

  // Flush dwell times
  for (const tab of session.tabs) {
    const dwell = _dwellMap.get(tab.tabId);
    if (dwell !== undefined) {
      tab.dwellTimeMs = (tab.dwellTimeMs ?? 0) + dwell;
      _dwellMap.delete(tab.tabId);
    }
  }

  session.endedAt = Date.now();

  // Run clustering
  await clusterSession(session);

  const state = await storage.getDetectionState();
  state.activeSessionId = undefined;
  state.sessionPromptedAt = undefined;
  await storage.saveDetectionState(state);

  chrome.runtime.sendMessage({ type: "SESSION_ENDED", sessionId }).catch(() => {});
}

async function clusterSession(session: ResearchSession): Promise<void> {
  const settings = await storage.getSettings();
  const tabs = session.tabs;

  if (tabs.length === 0) return;

  // Build TF-IDF vectors
  const vectors = buildCorpusTFIDF(
    tabs.map((t) => ({ title: t.title, body: t.bodySnippet + " " + t.headings.join(" ") }))
  );

  // Optionally get AI embeddings
  if (settings.aiEnabled) {
    const apiKey = await storage.getGeminiKey();
    if (apiKey) {
      const texts = tabs.map((t) =>
        [t.title, t.metaDescription, t.headings.slice(0, 5).join(", "), t.bodySnippet.slice(0, 300)].join(" ")
      );
      const embeddings = await batchEmbeddings(texts, apiKey);
      tabs.forEach((tab, i) => {
        if (embeddings[i].length > 0) tab.embedding = embeddings[i];
      });
    }
  }

  // Store TF-IDF vectors on tabs temporarily
  tabs.forEach((tab, i) => { tab.tfidfVector = vectors[i]; });

  // Detect duplicates
  const dupeIndices = findDuplicates(tabs, vectors);
  dupeIndices.forEach((i) => { tabs[i].isDuplicate = true; });

  // Cluster
  const clusters = clusterTabs(tabs, vectors);
  session.clusters = clusters;

  // Auto-name session
  session.title = autoNameSession(clusters);

  // Create tab groups in Chrome
  const tabUrlMap = new Map(tabs.map((t) => [t.tabId, t.url]));
  await createTabGroups(clusters, tabUrlMap);

  // Strip vectors from storage (save quota)
  tabs.forEach((tab) => { delete tab.embedding; delete tab.tfidfVector; });

  await storage.saveSession(session);

  // Optionally generate AI session summary
  if (settings.aiEnabled) {
    const apiKey = await storage.getGeminiKey();
    if (apiKey) {
      try {
        const { summarizeSession } = await import("../lib/summarizer.js");
        const result = await summarizeSession(
          session.title,
          clusters.map((c) => c.label),
          tabs.map((t) => t.title),
          apiKey
        );
        session.summary = result.summary;
        session.takeaways = result.takeaways;
        session.openQuestions = result.openQuestions;
        await storage.saveSession(session);
      } catch {
        // AI summary failed — continue without it
      }
    }
  }
}

// ── Popup/dashboard message bridge ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATE") {
    storage.getDetectionState().then((state) => sendResponse({ state }));
    return true;
  }
  if (msg.type === "START_SESSION") {
    startSession().then((id) => sendResponse({ sessionId: id }));
    return true;
  }
  if (msg.type === "END_SESSION") {
    endSession(msg.sessionId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSystemTab(url: string): boolean {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url === "" ||
    url === "about:blank"
  );
}
