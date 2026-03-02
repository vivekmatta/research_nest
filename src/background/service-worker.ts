// ResearchNest background service worker — MV3

import * as storage from "../lib/storage.js";
import { buildCorpusTFIDF } from "../lib/tfidf.js";
import { clusterTabs, autoNameSession, findDuplicates } from "../lib/clustering.js";
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
const _dwellMap = new Map<number, number>();

function recordDwell(tabId: number | null): void {
  if (tabId === null || _activeStartTime === null) return;
  const elapsed = Date.now() - _activeStartTime;
  _dwellMap.set(tabId, (_dwellMap.get(tabId) ?? 0) + elapsed);
}

// ── Content extraction countdown latch ───────────────────────────────────────

const _pendingExtractions = new Map<string, {
  resolve: () => void;
  remaining: number;
  totalExpected: number;
}>();

// ── Tab event handlers ────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  recordDwell(_activeTabId);
  _activeTabId = tabId;
  _activeStartTime = Date.now();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id) return;

  const settings = await storage.getSettings();
  const state = await storage.getDetectionState();

  const url = tab.url ?? "";

  // Track for session detection
  if (settings.autoDetectEnabled && url && !isSystemTab(url)) {
    state.recentTabEvents.push({
      tabId: tab.id,
      timestamp: Date.now(),
      windowId: tab.windowId,
    });
    await storage.saveDetectionState(state);
    await checkForSessionTrigger(state);
  }

  // Track new tabs added during an active session for re-clustering
  if (state.activeSessionId && url && !isSystemTab(url)) {
    const updatedState = await storage.getDetectionState();
    updatedState.newTabsSinceCluster = [...(updatedState.newTabsSinceCluster ?? []), tab.id];

    // Add basic stub to session so re-cluster picks it up
    const session = await storage.getSession(updatedState.activeSessionId!);
    if (session && !session.tabs.find((t) => t.tabId === tab.id)) {
      session.tabs.push({
        tabId: tab.id,
        windowId: tab.windowId,
        url,
        title: tab.title ?? url,
        metaDescription: "",
        headings: [],
        bodySnippet: "",
        capturedAt: Date.now(),
      });
      await storage.saveSession(session);
    }
    await storage.saveDetectionState(updatedState);

    // Notify popup to refresh re-cluster badge
    chrome.runtime.sendMessage({ type: "NEW_TAB_ADDED" }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
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

  // Decrement latch counter
  const latch = _pendingExtractions.get(state.activeSessionId);
  if (latch) {
    latch.remaining = Math.max(0, latch.remaining - 1);
    const done = latch.totalExpected - latch.remaining;
    chrome.runtime.sendMessage({
      type: "EXTRACTION_PROGRESS",
      done,
      total: latch.totalExpected,
    }).catch(() => {});
    if (latch.remaining === 0) {
      latch.resolve();
    }
  }
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

  if (state.sessionPromptedAt && Date.now() - state.sessionPromptedAt < 120_000) {
    return;
  }

  const windowMs = settings.detectionWindowMinutes * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const recent = state.recentTabEvents.filter((e) => e.timestamp > cutoff);

  if (recent.length < settings.detectionThreshold) return;

  state.sessionPromptedAt = Date.now();
  await storage.saveDetectionState(state);

  chrome.notifications.create("session-detected", {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "ResearchNest: Research session detected!",
    message: `You've opened ${recent.length} tabs in ${settings.detectionWindowMinutes} minutes. Start a session?`,
    buttons: [{ title: "Cluster My Tabs" }, { title: "Dismiss" }],
    requireInteraction: true,
  });
}

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (notifId !== "session-detected") return;
  chrome.notifications.clear(notifId);
  if (btnIdx === 0) {
    await startAndClusterSession();
  }
});

// ── Session lifecycle ─────────────────────────────────────────────────────────

async function waitForContentExtraction(
  sessionId: string,
  expectedCount: number,
  timeoutMs: number
): Promise<void> {
  if (expectedCount === 0) return;

  return new Promise<void>((resolve) => {
    _pendingExtractions.set(sessionId, {
      resolve,
      remaining: expectedCount,
      totalExpected: expectedCount,
    });

    setTimeout(() => {
      // Timeout: resolve regardless of how many responses arrived
      if (_pendingExtractions.has(sessionId)) {
        _pendingExtractions.delete(sessionId);
        resolve();
      }
    }, timeoutMs);
  }).finally(() => {
    _pendingExtractions.delete(sessionId);
  });
}

export async function startAndClusterSession(): Promise<{ sessionId: string; clusterCount: number }> {
  const state = await storage.getDetectionState();
  if (state.activeSessionId) {
    const existing = await storage.getSession(state.activeSessionId);
    return { sessionId: state.activeSessionId, clusterCount: existing?.clusters.length ?? 0 };
  }

  // Get current browser window
  const currentWindow = await chrome.windows.getLastFocused({
    populate: false,
    windowTypes: ["normal"],
  }).catch(() => null);
  const windowId = currentWindow?.id ?? 0;

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
  state.newTabsSinceCluster = [];
  state.lastClusteredAt = undefined;
  await storage.saveDetectionState(state);

  // Inject content scripts and count injectable tabs
  let injectableCount = 0;
  for (const tab of validTabs) {
    if (!tab.id || !tab.url || isSystemTab(tab.url)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/content-script.js"],
      });
      injectableCount++;
    } catch {
      const tabIdx = session.tabs.findIndex((td) => td.tabId === tab.id);
      if (tabIdx >= 0) session.tabs[tabIdx].captureFailed = true;
    }
  }
  await storage.saveSession(session);

  // Broadcast initial progress
  chrome.runtime.sendMessage({
    type: "EXTRACTION_PROGRESS",
    done: 0,
    total: injectableCount,
  }).catch(() => {});

  // Wait for content scripts to respond (up to 5 seconds)
  await waitForContentExtraction(session.sessionId, injectableCount, 5000);

  // Re-read session with enriched content
  const enrichedSession = await storage.getSession(session.sessionId);
  if (!enrichedSession) return { sessionId: session.sessionId, clusterCount: 0 };

  // Run clustering
  chrome.runtime.sendMessage({ type: "EXTRACTION_PROGRESS", done: injectableCount, total: injectableCount }).catch(() => {});
  await clusterSession(enrichedSession);

  // Update detection state
  const updatedState = await storage.getDetectionState();
  updatedState.lastClusteredAt = Date.now();
  updatedState.newTabsSinceCluster = [];
  await storage.saveDetectionState(updatedState);

  const finalSession = await storage.getSession(session.sessionId);
  const clusterCount = finalSession?.clusters.length ?? 0;

  chrome.runtime.sendMessage({ type: "CLUSTER_COMPLETE", sessionId: session.sessionId, clusterCount }).catch(() => {});

  return { sessionId: session.sessionId, clusterCount };
}

export async function reclusterSession(sessionId: string): Promise<void> {
  const state = await storage.getDetectionState();
  const newTabIds = state.newTabsSinceCluster ?? [];

  // Inject content scripts into new tabs
  let injectableCount = 0;
  for (const tabId of newTabIds) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/content-script.js"],
      });
      injectableCount++;
    } catch {
      const session = await storage.getSession(sessionId);
      if (session) {
        const idx = session.tabs.findIndex((t) => t.tabId === tabId);
        if (idx >= 0) session.tabs[idx].captureFailed = true;
        await storage.saveSession(session);
      }
    }
  }

  if (injectableCount > 0) {
    chrome.runtime.sendMessage({
      type: "EXTRACTION_PROGRESS",
      done: 0,
      total: injectableCount,
    }).catch(() => {});
    await waitForContentExtraction(sessionId, injectableCount, 5000);
  }

  const session = await storage.getSession(sessionId);
  if (!session) return;

  await clusterSession(session);

  const updatedState = await storage.getDetectionState();
  updatedState.newTabsSinceCluster = [];
  updatedState.lastClusteredAt = Date.now();
  await storage.saveDetectionState(updatedState);

  const finalSession = await storage.getSession(sessionId);
  chrome.runtime.sendMessage({
    type: "CLUSTER_COMPLETE",
    sessionId,
    clusterCount: finalSession?.clusters.length ?? 0,
  }).catch(() => {});
}

export async function archiveSession(sessionId: string): Promise<void> {
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
  await storage.saveSession(session);

  const state = await storage.getDetectionState();
  state.activeSessionId = undefined;
  state.newTabsSinceCluster = [];
  state.sessionPromptedAt = undefined;
  await storage.saveDetectionState(state);

  chrome.runtime.sendMessage({ type: "SESSION_ARCHIVED", sessionId }).catch(() => {});
}

async function clusterSession(session: ResearchSession): Promise<void> {
  const settings = await storage.getSettings();
  const tabs = session.tabs;

  if (tabs.length === 0) return;

  const vectors = buildCorpusTFIDF(
    tabs.map((t) => ({
      title: t.title,
      body: [t.metaDescription, t.bodySnippet, t.headings.join(" ")].filter(Boolean).join(" "),
    }))
  );

  tabs.forEach((tab, i) => { tab.tfidfVector = vectors[i]; });

  const dupeIndices = findDuplicates(tabs, vectors);
  dupeIndices.forEach((i) => { tabs[i].isDuplicate = true; });

  const clusters = clusterTabs(tabs, vectors);
  session.clusters = clusters;

  session.title = autoNameSession(clusters);

  const tabUrlMap = new Map(tabs.map((t) => [t.tabId, t.url]));
  await createTabGroups(clusters, tabUrlMap);

  tabs.forEach((tab) => { delete tab.tfidfVector; });

  await storage.saveSession(session);

  if (settings.aiEnabled) {
    const apiKey = await storage.getGeminiKey();
    if (apiKey) {
      void import("../lib/summarizer.js")
        .then(({ summarizeSession }) =>
          summarizeSession(
            session.title,
            clusters.map((c) => c.label),
            tabs.map((t) => t.title),
            apiKey
          )
        )
        .then(async (result) => {
          const s = await storage.getSession(session.sessionId);
          if (!s) return;
          s.summary = result.summary;
          s.takeaways = result.takeaways;
          s.openQuestions = result.openQuestions;
          await storage.saveSession(s);
        })
        .catch(() => {});
    }
  }
}

// ── Message bridge ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATE") {
    storage.getDetectionState().then((state) => sendResponse({ state }));
    return true;
  }
  if (msg.type === "START_AND_CLUSTER") {
    startAndClusterSession()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === "RECLUSTER_SESSION") {
    reclusterSession(msg.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === "ARCHIVE_SESSION") {
    archiveSession(msg.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  // Legacy aliases kept for backward compat
  if (msg.type === "START_SESSION") {
    startAndClusterSession()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === "END_SESSION") {
    archiveSession(msg.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: String(err) }));
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
