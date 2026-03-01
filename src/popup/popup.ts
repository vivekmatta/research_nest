import "./popup.css";
import type { SessionDetectionState, ResearchSession } from "../types/index.js";

type PopupState = "idle" | "active" | "prompt";

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;

const stateIdle = $<HTMLDivElement>("state-idle");
const stateActive = $<HTMLDivElement>("state-active");
const statePrompt = $<HTMLDivElement>("state-prompt");
const loading = $<HTMLDivElement>("loading");
const loadingMsg = $<HTMLParagraphElement>("loading-msg");

function show(state: PopupState) {
  stateIdle.classList.toggle("hidden", state !== "idle");
  stateActive.classList.toggle("hidden", state !== "active");
  statePrompt.classList.toggle("hidden", state !== "prompt");
}

function showLoading(msg: string) {
  loadingMsg.textContent = msg;
  loading.classList.remove("hidden");
}
function hideLoading() { loading.classList.add("hidden"); }

async function getState(): Promise<SessionDetectionState> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      resolve(res?.state ?? { recentTabEvents: [] });
    });
  });
}

async function getActiveSession(sessionId: string): Promise<ResearchSession | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get("rn_sessions", (res) => {
      const sessions: ResearchSession[] = res["rn_sessions"] ?? [];
      resolve(sessions.find((s) => s.sessionId === sessionId) ?? null);
    });
  });
}

function formatDuration(startMs: number): string {
  const elapsed = Date.now() - startMs;
  const minutes = Math.floor(elapsed / 60000);
  return `${minutes}m`;
}

async function render() {
  const state = await getState();

  if (state.activeSessionId) {
    const session = await getActiveSession(state.activeSessionId);
    if (session) {
      $<HTMLSpanElement>("session-title").textContent = session.title;
      $<HTMLSpanElement>("tab-count").textContent = String(session.tabs.length);
      $<HTMLSpanElement>("cluster-count").textContent =
        session.clusters.length > 0 ? String(session.clusters.length) : "—";
      $<HTMLSpanElement>("duration-val").textContent = formatDuration(session.createdAt);
      show("active");
      return;
    }
  }

  // Check if detection recently fired
  const settings = await new Promise<{ detectionThreshold: number; detectionWindowMinutes: number }>((r) => {
    chrome.storage.local.get("rn_settings", (res) => {
      r({ detectionThreshold: 8, detectionWindowMinutes: 5, ...(res["rn_settings"] ?? {}) });
    });
  });

  const windowMs = settings.detectionWindowMinutes * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const recent = state.recentTabEvents.filter((e) => e.timestamp > cutoff);

  if (recent.length >= settings.detectionThreshold && !state.activeSessionId) {
    $<HTMLParagraphElement>("prompt-msg").textContent =
      `You've opened ${recent.length} tabs in ${settings.detectionWindowMinutes} minutes. Start a session?`;
    show("prompt");
  } else {
    show("idle");
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

$("btn-start").addEventListener("click", async () => {
  showLoading("Starting session…");
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: "START_SESSION" }, () => resolve());
  });
  await render();
  hideLoading();
});

$("btn-end").addEventListener("click", async () => {
  const state = await getState();
  if (!state.activeSessionId) return;
  showLoading("Clustering tabs…");
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: "END_SESSION", sessionId: state.activeSessionId }, () => resolve());
  });
  await render();
  hideLoading();
});

$("btn-confirm-start").addEventListener("click", async () => {
  showLoading("Starting session…");
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: "START_SESSION" }, () => resolve());
  });
  await render();
  hideLoading();
});

$("btn-dismiss").addEventListener("click", () => show("idle"));

$("btn-dashboard-idle").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  window.close();
});

$("btn-dashboard-active").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  window.close();
});

$("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Initial render
render();
