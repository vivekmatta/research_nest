import "./dashboard.css";
import type { ResearchSession, TabData } from "../types/index.js";
import { exportToMarkdown, downloadMarkdown } from "../lib/exporter.js";
import { summarizeTab } from "../lib/summarizer.js";
import { getGeminiKey, getSettings } from "../lib/storage.js";

// ── State ─────────────────────────────────────────────────────────────────────

let allSessions: ResearchSession[] = [];
let activeSessionId: string | null = null;
let searchQuery = "";

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
const sessionList = $<HTMLDivElement>("session-list");
const welcome = $<HTMLDivElement>("welcome");
const sessionDetail = $<HTMLDivElement>("session-detail");
const searchInput = $<HTMLInputElement>("search-input");
const hoverCard = $<HTMLDivElement>("hover-card");

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadSessions(): Promise<void> {
  const result = await chrome.storage.local.get("rn_sessions");
  allSessions = (result["rn_sessions"] as ResearchSession[]) ?? [];
  renderSidebar();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar(): void {
  const q = searchQuery.toLowerCase();
  let filtered = allSessions.slice().sort((a, b) => b.createdAt - a.createdAt);

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

  // Title
  const titleEl = $<HTMLHeadingElement>("detail-title");
  titleEl.textContent = session.title;

  const dateEl = $<HTMLSpanElement>("detail-date");
  const date = new Date(session.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const duration = session.endedAt
    ? formatDuration(session.endedAt - session.createdAt)
    : "in progress";
  dateEl.textContent = `${date} · ${duration} · ${session.tabs.length} tabs`;

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

  // Cluster grid
  renderClusterGrid(session);
}

function renderClusterGrid(session: ResearchSession): void {
  const grid = $<HTMLDivElement>("cluster-grid");

  if (session.clusters.length === 0) {
    // No clusters yet — show flat tab list
    grid.innerHTML = `<div class="cluster-card">
      <div class="cluster-header">
        <div class="cluster-dot color-grey"></div>
        <span class="cluster-label">All Tabs</span>
        <span class="cluster-count">${session.tabs.length}</span>
      </div>
      <div class="tab-list">${session.tabs.map((t) => tabItemHtml(t)).join("")}</div>
    </div>`;
  } else {
    grid.innerHTML = session.clusters.map((cluster) => {
      const clusterTabs = cluster.tabIds
        .map((id) => session.tabs.find((t) => t.tabId === id))
        .filter(Boolean) as TabData[];
      return `<div class="cluster-card">
        <div class="cluster-header">
          <div class="cluster-dot color-${cluster.color}"></div>
          <span class="cluster-label">${escHtml(cluster.label)}</span>
          <span class="cluster-count">${clusterTabs.length}</span>
        </div>
        <div class="cluster-keywords">Keywords: ${cluster.keywords.slice(0, 5).join(", ")}</div>
        <div class="tab-list">${clusterTabs.map((t) => tabItemHtml(t)).join("")}</div>
      </div>`;
    }).join("");
  }

  // Attach hover events
  grid.querySelectorAll(".tab-item").forEach((el) => {
    const tabId = parseInt((el as HTMLElement).dataset["tabId"] ?? "0");
    const sessionId = session.sessionId;

    el.addEventListener("mouseenter", (e) => showHoverCard(tabId, sessionId, e as MouseEvent));
    el.addEventListener("mousemove", (e) => repositionHoverCard(e as MouseEvent));
    el.addEventListener("mouseleave", () => hideHoverCard());
    el.addEventListener("click", () => {
      const tab = session.tabs.find((t) => t.tabId === tabId);
      if (tab?.url) chrome.tabs.create({ url: tab.url });
    });
  });
}

function tabItemHtml(tab: TabData): string {
  const dupeClass = tab.isDuplicate ? " duplicate" : "";
  const dupeBadge = tab.isDuplicate ? `<span class="duplicate-badge">dup</span>` : "";
  const dwell = tab.dwellTimeMs ? `<span class="tab-dwell">${formatDwell(tab.dwellTimeMs)}</span>` : "";
  const domain = safeHostname(tab.url);
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?sz=16&domain=${domain}` : "";
  const favicon = faviconUrl
    ? `<img class="tab-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">`
    : "";
  return `<div class="tab-item${dupeClass}" data-tab-id="${tab.tabId}" title="${escHtml(tab.url)}">
    ${favicon}
    <span class="tab-title">${escHtml(tab.title || tab.url)}</span>
    ${dupeBadge}${dwell}
  </div>`;
}

// ── Hover card ────────────────────────────────────────────────────────────────

let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

async function showHoverCard(tabId: number, sessionId: string, e: MouseEvent): Promise<void> {
  hoverTimeout = setTimeout(async () => {
    const session = allSessions.find((s) => s.sessionId === sessionId);
    if (!session) return;
    const tab = session.tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    $<HTMLImageElement>("hover-favicon-img").src =
      `https://www.google.com/s2/favicons?sz=16&domain=${safeHostname(tab.url)}`;
    $("hover-title").textContent = tab.title;
    $("hover-url").textContent = tab.url;
    $("hover-dwell").textContent = tab.dwellTimeMs ? `Time: ${formatDwell(tab.dwellTimeMs)}` : "";

    const bulletsList = $<HTMLUListElement>("hover-bullets");
    const hoverLoading = $("hover-loading");

    if (tab.summaryBullets && tab.summaryBullets.length > 0) {
      bulletsList.innerHTML = tab.summaryBullets.map((b) => `<li>${escHtml(b)}</li>`).join("");
      hoverLoading.classList.add("hidden");
    } else {
      bulletsList.innerHTML = "";
      hoverLoading.classList.remove("hidden");
      hoverCard.classList.remove("hidden");
      repositionHoverCard(e);

      // Generate on demand
      const settings = await getSettings();
      const apiKey = settings.aiEnabled ? await getGeminiKey() : null;
      const result = await summarizeTab(tab, apiKey, settings.aiEnabled);
      tab.summaryBullets = result.bullets;

      // Persist updated tab
      const idx = session.tabs.findIndex((t) => t.tabId === tabId);
      if (idx >= 0) session.tabs[idx] = tab;
      await chrome.storage.local.get("rn_sessions").then(async (res) => {
        const sessions: ResearchSession[] = res["rn_sessions"] ?? [];
        const si = sessions.findIndex((s) => s.sessionId === sessionId);
        if (si >= 0) sessions[si] = session;
        await chrome.storage.local.set({ rn_sessions: sessions });
      });

      hoverLoading.classList.add("hidden");
      bulletsList.innerHTML = result.bullets.map((b) => `<li>${escHtml(b)}</li>`).join("");
    }

    hoverCard.classList.remove("hidden");
    repositionHoverCard(e);
  }, 400);
}

function repositionHoverCard(e: MouseEvent): void {
  const x = e.clientX + 16;
  const y = e.clientY + 8;
  const w = hoverCard.offsetWidth;
  const h = hoverCard.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  hoverCard.style.left = `${Math.min(x, vw - w - 8)}px`;
  hoverCard.style.top = `${Math.min(y, vh - h - 8)}px`;
}

function hideHoverCard(): void {
  if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
  hoverCard.classList.add("hidden");
}

// ── Actions ───────────────────────────────────────────────────────────────────

$("btn-new-session").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "START_SESSION" }, async () => {
    await loadSessions();
    const state = await chrome.storage.session.get("rn_detection");
    const detection = state["rn_detection"] as { activeSessionId?: string } | undefined;
    if (detection?.activeSessionId) selectSession(detection.activeSessionId);
  });
});

$("btn-welcome-start").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "START_SESSION" }, async () => {
    await loadSessions();
  });
});

$("btn-export").addEventListener("click", () => {
  if (!activeSessionId) return;
  const session = allSessions.find((s) => s.sessionId === activeSessionId);
  if (!session) return;
  const md = exportToMarkdown(session);
  const safeName = session.title.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  downloadMarkdown(md, `researchnest-${safeName}.md`);
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

// ── Search ────────────────────────────────────────────────────────────────────

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderSidebar();
  // If active session doesn't match search, deselect
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

loadSessions();

// Listen for storage changes (session updates from background)
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
