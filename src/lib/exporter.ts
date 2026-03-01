// Markdown export

import type { ResearchSession } from "../types/index.js";

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDwell(ms?: number): string {
  if (!ms) return "unknown";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

export function exportToMarkdown(session: ResearchSession): string {
  const date = new Date(session.createdAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  const duration = session.endedAt
    ? formatDuration(session.endedAt - session.createdAt)
    : "in progress";

  const lines: string[] = [
    `# Research Session: ${session.title}`,
    `Date: ${date} | Duration: ${duration} | Tabs: ${session.tabs.length}`,
    "",
  ];

  if (session.summary) {
    lines.push("## Session Summary", session.summary, "");
  }

  if (session.takeaways && session.takeaways.length > 0) {
    lines.push("## Key Takeaways");
    session.takeaways.forEach((t) => lines.push(`- ${t}`));
    lines.push("");
  }

  if (session.openQuestions && session.openQuestions.length > 0) {
    lines.push("## Open Questions");
    session.openQuestions.forEach((q) => lines.push(`- ${q}`));
    lines.push("");
  }

  for (const cluster of session.clusters) {
    lines.push("---", `## Cluster: ${cluster.label}`);
    if (cluster.keywords.length > 0) {
      lines.push(`*Keywords: ${cluster.keywords.join(", ")}*`);
    }
    lines.push("");

    const clusterTabs = cluster.tabIds
      .map((id) => session.tabs.find((t) => t.tabId === id))
      .filter(Boolean);

    for (const tab of clusterTabs) {
      if (!tab) continue;
      lines.push(`### ${tab.title || tab.url}`);
      lines.push(`URL: ${tab.url}`);
      lines.push(`Time on tab: ${formatDwell(tab.dwellTimeMs)}`);

      if (tab.summaryBullets && tab.summaryBullets.length > 0) {
        lines.push("", "**Summary:**");
        tab.summaryBullets.forEach((b) => lines.push(`- ${b}`));
      }

      if (tab.headings.length > 0) {
        lines.push("", `**Headings:** ${tab.headings.slice(0, 5).join(", ")}`);
      }

      lines.push("");
    }
  }

  // Any unclustered tabs
  const clusteredTabIds = new Set(session.clusters.flatMap((c) => c.tabIds));
  const unclustered = session.tabs.filter((t) => !clusteredTabIds.has(t.tabId));
  if (unclustered.length > 0) {
    lines.push("---", "## Unclustered Tabs", "");
    for (const tab of unclustered) {
      lines.push(`- [${tab.title || tab.url}](${tab.url})`);
    }
  }

  return lines.join("\n");
}

export function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
