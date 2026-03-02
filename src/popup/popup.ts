import "./popup.css";
import type { SessionDetectionState, ResearchSession } from "../types/index.js";

type PopupState = "idle" | "active" | "prompt";

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;

const stateIdle = $<HTMLDivElement>("state-idle");
const stateActive = $<HTMLDivElement>("state-active");
const statePrompt = $<HTMLDivElement>("state-prompt");
const progressOverlay = $<HTMLDivElement>("progress-overlay");
const progressStep = $<HTMLParagraphElement>("progress-step");
const progressDetail = $<HTMLParagraphElement>("progress-detail");

function show(state: PopupState) {
  stateIdle.classList.toggle("hidden", state !== "idle");
  stateActive.classList.toggle("hidden", state !== "active");
  statePrompt.classList.toggle("hidden", state !== "prompt");
}

function showProgress(step: string, detail = "") {
  progressStep.textContent = step;
  progressDetail.textContent = detail;
  progressOverlay.classList.remove("hidden");
}

function hideProgress() {
  progressOverlay.classList.add("hidden");
}

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

      // Re-cluster badge
      const newTabs = state.newTabsSinceCluster ?? [];
      const btnRecluster = $<HTMLButtonElement>("btn-recluster");
      const newTabCountEl = $<HTMLSpanElement>("new-tab-count");
      if (newTabs.length > 0) {
        newTabCountEl.textContent = String(newTabs.length);
        btnRecluster.classList.remove("hidden");
      } else {
        btnRecluster.classList.add("hidden");
      }

      show("active");
      return;
    }
  }

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
      `You've opened ${recent.length} tabs in ${settings.detectionWindowMinutes} minutes. Cluster them?`;
    show("prompt");
  } else {
    show("idle");
  }
}

// ── Listen for background progress events ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "EXTRACTION_PROGRESS") {
    showProgress("Extracting content…", `${msg.done} / ${msg.total} tabs`);
  }
  if (msg.type === "CLUSTER_COMPLETE") {
    showProgress("Done!", `${msg.clusterCount} cluster${msg.clusterCount !== 1 ? "s" : ""} created`);
    setTimeout(() => {
      hideProgress();
      void render();
    }, 800);
  }
  if (msg.type === "SESSION_ARCHIVED") {
    void render();
  }
  if (msg.type === "NEW_TAB_ADDED") {
    void render();
  }
});

// ── Start clustering ───────────────────────────────────────────────────────────

async function startClustering() {
  showProgress("Starting…", "");
  const res = await new Promise<{ sessionId?: string; clusterCount?: number; error?: string }>((resolve) => {
    chrome.runtime.sendMessage({ type: "START_AND_CLUSTER" }, (r) => resolve(r ?? {}));
  });
  if (res.error) {
    hideProgress();
    alert(`Failed to start: ${res.error}`);
  }
  // Progress overlay stays up; CLUSTER_COMPLETE message will dismiss it
}

$("btn-start").addEventListener("click", () => { void startClustering(); });
$("btn-confirm-start").addEventListener("click", () => { void startClustering(); });

// ── Re-cluster ────────────────────────────────────────────────────────────────

$("btn-recluster").addEventListener("click", async () => {
  const state = await getState();
  if (!state.activeSessionId) return;
  showProgress("Extracting new tabs…", "");
  chrome.runtime.sendMessage(
    { type: "RECLUSTER_SESSION", sessionId: state.activeSessionId },
    () => {}
  );
  // CLUSTER_COMPLETE will dismiss overlay and re-render
});

// ── Archive ───────────────────────────────────────────────────────────────────

$("btn-archive").addEventListener("click", async () => {
  const state = await getState();
  if (!state.activeSessionId) return;
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: "ARCHIVE_SESSION", sessionId: state.activeSessionId }, () => resolve());
  });
  await render();
});

// ── Navigation ────────────────────────────────────────────────────────────────

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
void render();
