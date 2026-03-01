// Chrome Tab Groups API wrapper

import type { Cluster } from "../types/index.js";

const NON_GROUPABLE_PREFIXES = ["chrome://", "chrome-extension://", "about:", "edge://", "data:"];

function isGroupable(url: string): boolean {
  return !NON_GROUPABLE_PREFIXES.some((p) => url.startsWith(p));
}

export async function createTabGroups(
  clusters: Cluster[],
  tabUrlMap: Map<number, string>
): Promise<void> {
  for (const cluster of clusters) {
    const groupableTabIds = cluster.tabIds.filter((id) => {
      const url = tabUrlMap.get(id);
      return url ? isGroupable(url) : false;
    });

    if (groupableTabIds.length === 0) continue;

    try {
      const groupId = await chrome.tabs.group({ tabIds: groupableTabIds });
      await chrome.tabGroups.update(groupId, {
        title: cluster.label.slice(0, 25),
        color: cluster.color,
      });
    } catch (err) {
      console.warn(`[ResearchNest] Failed to create tab group for cluster "${cluster.label}":`, err);
    }
  }
}

export async function ungroupAllTabs(tabIds: number[]): Promise<void> {
  try {
    await chrome.tabs.ungroup(tabIds);
  } catch {
    // Ignore — tabs may already be ungrouped or closed
  }
}
