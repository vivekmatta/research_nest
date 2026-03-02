import "./dashboard.css";
import type { ResearchSession, TabData } from "../types/index.js";
import { exportToMarkdown, downloadMarkdown } from "../lib/exporter.js";
import { summarizeTab } from "../lib/summarizer.js";
import { getGeminiKey, getSettings } from "../lib/storage.js";

// ── State ─────────────────────────────────────────────────────────────────────

let allSessions: ResearchSession[] = [];
let activeSessionId: string | null = null;
let searchQuery = "";
let sortOrder: "newest" | "oldest" = "newest";
let collapsedClusters = new Set<string>();

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
const sessionList = $<HTMLDivElement>("session-list");
const welcome = $<HTMLDivElement>("welcome");
const sessionDetail = $<HTMLDivElement>("session-detail");
const panelPlaceholder = $<HTMLDivElement>("panel-placeholder");
const searchInput = $<HTMLInputElement>("search-input");

// Cluster color hex map
const COLOR_HEX: Record<string, string> = {
  blue: "#3b82f6", red: "#ef4444", yellow: "#eab308",
  green: "#22c55e", pink: "#ec4899", purple: "#8b5cf6",
  cyan: "#06b6d4", grey: "#6b7280",
};

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadSessions(): Promise<void> {
  const result = await chrome.storage.local.get("rn_sessions");
  allSessions = (result["rn_sessions"] as ResearchSession[]) ?? [];
  renderSidebar();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar(): void {
  const q = searchQuery.toLowerCase();
  let filtered = allSessions.slice().sort((a, b) =>
    sortOrder === "newest" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt
  );

  if (q) {
    filtered = filtered.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      s.tabs.some((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) ||
      s.clusters.some((c) => c.keywords.some((k) => k.includes(q)))
    );
  }

  if (filtered.length === 0) {
    sessionList.innerHTML = `<p class="empty-msg">${q ? "No results." : "No sessions yet."}</p>`;
    return;
  }

  sessionList.innerHTML = filtered.map((s) => {
    const date = new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const active = s.sessionId === activeSessionId ? " active" : "";
    return `<div class="session-item${active}" data-id="${s.sessionId}">
      <div class="session-item-title">${escHtml(s.title)}</div>
      <div class="session-item-meta">${date} · ${s.tabs.length} tabs · ${s.clusters.length} clusters</div>
    </div>`;
  }).join("");

  sessionList.querySelectorAll(".session-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).dataset["id"]!;
      selectSession(id);
    });
  });
}

// ── Session detail ────────────────────────────────────────────────────────────

function selectSession(id: string): void {
  activeSessionId = id;
  renderSidebar();
  const session = allSessions.find((s) => s.sessionId === id);
  if (!session) return;
  renderDetail(session);
}

function renderDetail(session: ResearchSession): void {
  welcome.classList.add("hidden");
  sessionDetail.classList.remove("hidden");
  panelPlaceholder.classList.add("hidden");

  const titleEl = $<HTMLHeadingElement>("detail-title");
  titleEl.textContent = session.title;

  const dateEl = $<HTMLSpanElement>("detail-date");
  const date = new Date(session.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const duration = session.endedAt
    ? formatDuration(session.endedAt - session.createdAt)
    : "in progress";
  dateEl.textContent = `${date} · ${duration}`;

  const tabBadge = document.getElementById("badge-tabs");
  const clusterBadge = document.getElementById("badge-clusters");
  if (tabBadge) tabBadge.textContent = `${session.tabs.length} tabs`;
  if (clusterBadge) clusterBadge.textContent = `${session.clusters.length} clusters`;

  // Summary panel
  const summaryPanel = $("summary-panel");
  if (session.summary) {
    summaryPanel.classList.remove("hidden");
    $("summary-text").textContent = session.summary;

    const takeawaysSection = $("takeaways-section");
    const takeawaysList = $("takeaways-list");
    if (session.takeaways && session.takeaways.length > 0) {
      takeawaysSection.classList.remove("hidden");
      takeawaysList.innerHTML = session.takeaways.map((t) => `<li>${escHtml(t)}</li>`).join("");
    } else {
      takeawaysSection.classList.add("hidden");
    }

    const questionsSection = $("questions-section");
    const questionsList = $("questions-list");
    if (session.openQuestions && session.openQuestions.length > 0) {
      questionsSection.classList.remove("hidden");
      questionsList.innerHTML = session.openQuestions.map((q) => `<li>${escHtml(q)}</li>`).join("");
    } else {
      questionsSection.classList.add("hidden");
    }
  } else {
    summaryPanel.classList.add("hidden");
  }

  renderClusterLanes(session);
}

// ── Cluster cards ─────────────────────────────────────────────────────────────

function renderClusterLanes(session: ResearchSession): void {
  const container = $<HTMLDivElement>("cluster-grid");

  const chevronSvg = `<svg class="cluster-chevron" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  if (session.clusters.length === 0) {
    const cardId = `card-all`;
    const isCollapsed = collapsedClusters.has(cardId) ? " collapsed" : "";
    container.innerHTML = `<div class="cluster-card${isCollapsed}" id="${cardId}" style="--i:0">
      <button class="cluster-card-header" data-card-id="${cardId}">
        <span class="cluster-accent-bar" style="background:#6b7280"></span>
        <span class="cluster-label">All Tabs</span>
        <span class="cluster-count">${session.tabs.length} tab${session.tabs.length !== 1 ? "s" : ""}</span>
        ${chevronSvg}
      </button>
      <div class="cluster-body">
        ${session.tabs.map(tabRowHtml).join("")}
      </div>
    </div>`;
  } else {
    container.innerHTML = session.clusters.map((cluster, i) => {
      const clusterTabs = cluster.tabIds
        .map((id) => session.tabs.find((t) => t.tabId === id))
        .filter(Boolean) as TabData[];
      const color = COLOR_HEX[cluster.color] ?? "#6b7280";
      const keywordPills = cluster.keywords.slice(0, 5)
        .map((k) => `<span class="keyword-pill">${escHtml(k)}</span>`)
        .join("");
      const cardId = `card-${cluster.label}-${i}`;
      const isCollapsed = collapsedClusters.has(cardId) ? " collapsed" : "";
      return `<div class="cluster-card${isCollapsed}" id="${escHtml(cardId)}" style="--i:${i}">
        <button class="cluster-card-header" data-card-id="${escHtml(cardId)}">
          <span class="cluster-accent-bar" style="background:${color}"></span>
          <span class="cluster-label">${escHtml(cluster.label)}</span>
          <div class="cluster-keywords">${keywordPills}</div>
          <span class="cluster-count">${clusterTabs.length} tab${clusterTabs.length !== 1 ? "s" : ""}</span>
          ${chevronSvg}
        </button>
        <div class="cluster-body">
          ${clusterTabs.map(tabRowHtml).join("")}
        </div>
      </div>`;
    }).join("");
  }

  // Cluster header collapse/expand
  container.querySelectorAll(".cluster-card-header").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cardId = (btn as HTMLElement).dataset["cardId"]!;
      const card = document.getElementById(cardId);
      if (!card) return;
      const isNowCollapsed = card.classList.toggle("collapsed");
      if (isNowCollapsed) {
        collapsedClusters.add(cardId);
      } else {
        collapsedClusters.delete(cardId);
      }
    });
  });

  // Tab row click → open modal
  container.querySelectorAll(".tab-row").forEach((el) => {
    const tabId = parseInt((el as HTMLElement).dataset["tabId"] ?? "0");
    el.addEventListener("click", () => void openTabModal(tabId, session.sessionId));
  });

  // Open in new tab button
  container.querySelectorAll(".open-tab-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = (btn as HTMLElement).dataset["url"];
      if (url) chrome.tabs.create({ url });
    });
  });

  // Copy link button
  container.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = (btn as HTMLElement).dataset["url"];
      if (url) void navigator.clipboard.writeText(url);
    });
  });
}

function tabRowHtml(tab: TabData): string {
  const domain = safeHostname(tab.url);
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?sz=16&domain=${domain}` : "";
  const favicon = faviconUrl
    ? `<img class="tab-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">`
    : `<span class="tab-favicon"></span>`;
  const dupeClass = tab.isDuplicate ? " tab-row--dup" : "";
  return `<div class="tab-row${dupeClass}" data-tab-id="${tab.tabId}">
    ${favicon}
    <div class="tab-info">
      <span class="tab-title">${escHtml(tab.title || tab.url)}</span>
      <span class="tab-domain">${escHtml(domain)}</span>
    </div>
    <div class="tab-actions">
      <button class="tab-action open-tab-btn" title="Open in new tab" data-url="${escHtml(tab.url)}">↗</button>
      <button class="tab-action copy-btn" title="Copy link" data-url="${escHtml(tab.url)}">⧉</button>
    </div>
  </div>`;
}

// ── Tab detail modal ──────────────────────────────────────────────────────────

async function openTabModal(tabId: number, sessionId: string): Promise<void> {
  const session = allSessions.find((s) => s.sessionId === sessionId);
  if (!session) return;
  const tab = session.tabs.find((t) => t.tabId === tabId);
  if (!tab) return;

  const domain = safeHostname(tab.url);

  // Favicon
  const faviconEl = $<HTMLImageElement>("modal-favicon");
  faviconEl.src = domain ? `https://www.google.com/s2/favicons?sz=24&domain=${domain}` : "";
  faviconEl.onerror = () => { faviconEl.style.display = "none"; };

  // Title + URL
  $("modal-title").textContent = tab.title || tab.url;
  const urlEl = $<HTMLAnchorElement>("modal-url");
  urlEl.textContent = tab.url;
  urlEl.href = tab.url;

  // Open link
  ($<HTMLAnchorElement>("modal-open-tab")).href = tab.url;

  // Dwell time
  $("modal-dwell").textContent = tab.dwellTimeMs
    ? `Time on tab: ${formatDwell(tab.dwellTimeMs)}`
    : "Dwell time not recorded";

  // Duplicate badge
  const dupEl = $("modal-duplicate");
  dupEl.classList.toggle("hidden", !tab.isDuplicate);

  // Summary bullets
  const spinner = $("modal-spinner");
  const bullets = $<HTMLUListElement>("modal-bullets");
  bullets.innerHTML = "";

  if (tab.summaryBullets && tab.summaryBullets.length > 0) {
    bullets.innerHTML = tab.summaryBullets.map((b) => `<li>${escHtml(b)}</li>`).join("");
    spinner.classList.add("hidden");
  } else {
    spinner.classList.remove("hidden");
    $("tab-modal-backdrop").classList.remove("hidden");
    document.body.style.overflow = "hidden";

    const settings = await getSettings();
    const apiKey = settings.aiEnabled ? await getGeminiKey() : null;
    const result = await summarizeTab(tab, apiKey, settings.aiEnabled);
    tab.summaryBullets = result.bullets;

    // Persist
    const si = allSessions.findIndex((s) => s.sessionId === sessionId);
    if (si >= 0) {
      const ti = allSessions[si].tabs.findIndex((t) => t.tabId === tabId);
      if (ti >= 0) allSessions[si].tabs[ti] = tab;
      const res = await chrome.storage.local.get("rn_sessions");
      const sessions: ResearchSession[] = res["rn_sessions"] ?? [];
      const idx = sessions.findIndex((s) => s.sessionId === sessionId);
      if (idx >= 0) sessions[idx] = allSessions[si];
      await chrome.storage.local.set({ rn_sessions: sessions });
    }

    spinner.classList.add("hidden");
    bullets.innerHTML = result.bullets.map((b) => `<li>${escHtml(b)}</li>`).join("");
    return; // backdrop already shown above
  }

  $("tab-modal-backdrop").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeTabModal(): void {
  $("tab-modal-backdrop").classList.add("hidden");
  document.body.style.overflow = "";
}

$("tab-modal-close").addEventListener("click", closeTabModal);
$("tab-modal-close-btn").addEventListener("click", closeTabModal);
$("tab-modal-backdrop").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "tab-modal-backdrop") closeTabModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTabModal();
});

// ── Actions ───────────────────────────────────────────────────────────────────

$("btn-new-session").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "START_AND_CLUSTER" }, async () => {
    await loadSessions();
    const state = await chrome.storage.session.get("rn_detection");
    const detection = state["rn_detection"] as { activeSessionId?: string } | undefined;
    if (detection?.activeSessionId) selectSession(detection.activeSessionId);
  });
});

$("btn-welcome-start").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "START_AND_CLUSTER" }, async () => {
    await loadSessions();
  });
});

$("btn-export-md").addEventListener("click", () => {
  if (!activeSessionId) return;
  const session = allSessions.find((s) => s.sessionId === activeSessionId);
  if (!session) return;
  const md = exportToMarkdown(session);
  const safeName = session.title.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  downloadMarkdown(md, `researchnest-${safeName}.md`);
});

$("btn-export-json").addEventListener("click", () => {
  if (!activeSessionId) return;
  const session = allSessions.find((s) => s.sessionId === activeSessionId);
  if (!session) return;
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = session.title.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  a.href = url; a.download = `researchnest-${safeName}.json`; a.click();
  URL.revokeObjectURL(url);
});

$("btn-recluster").addEventListener("click", () => {
  if (!activeSessionId) return;
  chrome.runtime.sendMessage({ type: "RECLUSTER_SESSION", sessionId: activeSessionId });
});

$("btn-delete").addEventListener("click", async () => {
  if (!activeSessionId) return;
  if (!confirm("Delete this session? This cannot be undone.")) return;
  const result = await chrome.storage.local.get("rn_sessions");
  const sessions: ResearchSession[] = result["rn_sessions"] ?? [];
  await chrome.storage.local.set({
    rn_sessions: sessions.filter((s) => s.sessionId !== activeSessionId),
  });
  activeSessionId = null;
  await loadSessions();
  welcome.classList.remove("hidden");
  sessionDetail.classList.add("hidden");
  panelPlaceholder.classList.remove("hidden");
});

$("btn-edit-title").addEventListener("click", () => {
  if (!activeSessionId) return;
  const titleEl = $<HTMLHeadingElement>("detail-title");
  titleEl.contentEditable = "true";
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
});

$("detail-title").addEventListener("blur", async () => {
  const titleEl = $<HTMLHeadingElement>("detail-title");
  titleEl.contentEditable = "false";
  if (!activeSessionId) return;
  const newTitle = titleEl.textContent?.trim() ?? "";
  if (!newTitle) return;
  const result = await chrome.storage.local.get("rn_sessions");
  const sessions: ResearchSession[] = result["rn_sessions"] ?? [];
  const idx = sessions.findIndex((s) => s.sessionId === activeSessionId);
  if (idx >= 0) {
    sessions[idx].title = newTitle;
    allSessions = sessions;
    await chrome.storage.local.set({ rn_sessions: sessions });
    renderSidebar();
  }
});

$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Sort
document.getElementById("sort-select")?.addEventListener("change", (e) => {
  sortOrder = (e.target as HTMLSelectElement).value as "newest" | "oldest";
  renderSidebar();
});

// ── Search ────────────────────────────────────────────────────────────────────

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderSidebar();
  if (searchQuery && activeSessionId) {
    const session = allSessions.find((s) => s.sessionId === activeSessionId);
    if (session) {
      const q = searchQuery.toLowerCase();
      const matches = session.title.toLowerCase().includes(q) ||
        session.tabs.some((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) ||
        session.clusters.some((c) => c.keywords.some((k) => k.includes(q)));
      if (!matches) {
        activeSessionId = null;
        welcome.classList.remove("hidden");
        sessionDetail.classList.add("hidden");
        panelPlaceholder.classList.remove("hidden");
      }
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function formatDwell(ms: number): string {
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

// ── Init ──────────────────────────────────────────────────────────────────────

void loadSessions();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["rn_sessions"]) {
    allSessions = (changes["rn_sessions"].newValue as ResearchSession[]) ?? [];
    renderSidebar();
    if (activeSessionId) {
      const session = allSessions.find((s) => s.sessionId === activeSessionId);
      if (session) renderDetail(session);
    }
  }
});
