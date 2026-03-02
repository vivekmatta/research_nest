// K-means++ clustering — works on both sparse TF-IDF dicts and dense float arrays

import { cosineSimilarity, topKeywords, STOPWORDS } from "./tfidf.js";
import type { Cluster, TabData } from "../types/index.js";
import { CLUSTER_COLORS } from "../types/index.js";

// ── Distance helpers ──────────────────────────────────────────────────────────

function cosineDistanceSparse(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  return 1 - cosineSimilarity(a, b);
}

function cosineDistanceDense(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── K-means++ initialization ──────────────────────────────────────────────────

function kmeansppInitSparse(
  points: Record<string, number>[],
  k: number
): Record<string, number>[] {
  const centers: Record<string, number>[] = [];
  const idx = Math.floor(Math.random() * points.length);
  centers.push({ ...points[idx] });

  while (centers.length < k) {
    const dists = points.map((p) =>
      Math.min(...centers.map((c) => cosineDistanceSparse(p, c)))
    );
    const total = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { chosen = i; break; }
    }
    centers.push({ ...points[chosen] });
  }
  return centers;
}

function kmeansppInitDense(
  points: number[][],
  k: number
): number[][] {
  const centers: number[][] = [];
  centers.push([...points[Math.floor(Math.random() * points.length)]]);

  while (centers.length < k) {
    const dists = points.map((p) =>
      Math.min(...centers.map((c) => cosineDistanceDense(p, c)))
    );
    const total = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { chosen = i; break; }
    }
    centers.push([...points[chosen]]);
  }
  return centers;
}

// ── Centroid computation ──────────────────────────────────────────────────────

function centroidSparse(group: Record<string, number>[]): Record<string, number> {
  if (group.length === 0) return {};
  const result: Record<string, number> = {};
  for (const vec of group) {
    for (const [term, val] of Object.entries(vec)) {
      result[term] = (result[term] ?? 0) + val / group.length;
    }
  }
  return result;
}

function centroidDense(group: number[][]): number[] {
  if (group.length === 0) return [];
  const result = new Array<number>(group[0].length).fill(0);
  for (const vec of group) {
    for (let i = 0; i < vec.length; i++) result[i] += vec[i] / group.length;
  }
  return result;
}

// ── K-means core ──────────────────────────────────────────────────────────────

function kmeansSpare(
  points: Record<string, number>[],
  k: number,
  maxIter = 30
): number[] {
  let centers = kmeansppInitSparse(points, k);
  let assignments = new Array<number>(points.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    const newAssignments = points.map((p) => {
      let best = 0, bestDist = Infinity;
      for (let j = 0; j < centers.length; j++) {
        const d = cosineDistanceSparse(p, centers[j]);
        if (d < bestDist) { bestDist = d; best = j; }
      }
      return best;
    });

    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    if (!changed) break;

    for (let j = 0; j < k; j++) {
      const group = points.filter((_, i) => assignments[i] === j);
      if (group.length > 0) centers[j] = centroidSparse(group);
    }
  }
  return assignments;
}

function kmeansDense(
  points: number[][],
  k: number,
  maxIter = 30
): number[] {
  let centers = kmeansppInitDense(points, k);
  let assignments = new Array<number>(points.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    const newAssignments = points.map((p) => {
      let best = 0, bestDist = Infinity;
      for (let j = 0; j < centers.length; j++) {
        const d = cosineDistanceDense(p, centers[j]);
        if (d < bestDist) { bestDist = d; best = j; }
      }
      return best;
    });

    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    if (!changed) break;

    for (let j = 0; j < k; j++) {
      const group = points.filter((_, i) => assignments[i] === j);
      if (group.length > 0) centers[j] = centroidDense(group);
    }
  }
  return assignments;
}

// ── Inertia for elbow method ──────────────────────────────────────────────────

function inertia(
  points: Record<string, number>[],
  assignments: number[],
  k: number
): number {
  const groups: Record<string, number>[][] = Array.from({ length: k }, () => []);
  assignments.forEach((a, i) => groups[a].push(points[i]));
  const centers = groups.map(centroidSparse);
  return points.reduce(
    (sum, p, i) => sum + cosineDistanceSparse(p, centers[assignments[i]]),
    0
  );
}

// ── Auto-estimate K via elbow method ─────────────────────────────────────────

function estimateK(
  points: Record<string, number>[],
  maxK: number
): number {
  if (points.length <= 2) return 1;
  const kMax = Math.min(maxK, Math.floor(points.length / 2), 6);
  if (kMax < 2) return 1;

  const inertias: number[] = [];
  for (let k = 1; k <= kMax; k++) {
    const a = kmeansSpare(points, k);
    inertias.push(inertia(points, a, k));
  }

  // Find elbow: first k where relative improvement drops below 20%
  for (let i = 1; i < inertias.length; i++) {
    const prev = inertias[i - 1];
    const curr = inertias[i];
    if (prev === 0) return i;
    const improvement = (prev - curr) / prev;
    if (improvement < 0.05) return i; // k = i (1-indexed)
  }
  return kMax;
}

// ── Duplicate detection ───────────────────────────────────────────────────────

export function findDuplicates(
  tabs: TabData[],
  vectors: Record<string, number>[]
): Set<number> {
  const duplicates = new Set<number>();
  const domainMap = new Map<string, number[]>();

  tabs.forEach((tab, i) => {
    try {
      const domain = new URL(tab.url).hostname;
      const existing = domainMap.get(domain) ?? [];
      existing.push(i);
      domainMap.set(domain, existing);
    } catch {
      // skip invalid URLs
    }
  });

  for (const indices of domainMap.values()) {
    if (indices.length < 2) continue;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const sim = cosineSimilarity(vectors[indices[i]], vectors[indices[j]]);
        if (sim > 0.85) duplicates.add(indices[j]);
      }
    }
  }
  return duplicates;
}

// ── Reading order suggestion ──────────────────────────────────────────────────

export function suggestReadingOrder(clusterTabIndices: number[], tabs: TabData[]): number[] {
  // Score: shorter URL path = higher level overview = read first
  // Then go deeper (longer paths), putting ungrouped last
  return [...clusterTabIndices].sort((a, b) => {
    try {
      const depthA = new URL(tabs[a].url).pathname.split("/").filter(Boolean).length;
      const depthB = new URL(tabs[b].url).pathname.split("/").filter(Boolean).length;
      return depthA - depthB;
    } catch {
      return 0;
    }
  });
}

// ── Main clustering entry point ───────────────────────────────────────────────

export function clusterTabs(
  tabs: TabData[],
  tfidfVectors: Record<string, number>[]
): Cluster[] {
  if (tabs.length === 0) return [];
  if (tabs.length === 1) {
    return [{
      clusterId: crypto.randomUUID(),
      label: topKeywords(tfidfVectors[0], 2).join(" ") || "research",
      color: CLUSTER_COLORS[0],
      tabIds: [tabs[0].tabId],
      keywords: topKeywords(tfidfVectors[0], 5),
      readingOrder: [0],
    }];
  }

  // Use embeddings if available for all tabs, otherwise TF-IDF
  const hasEmbeddings = tabs.every((t) => t.embedding && t.embedding.length > 0);
  let assignments: number[];
  let k: number;

  if (hasEmbeddings) {
    const embeddings = tabs.map((t) => t.embedding!);
    k = estimateK(tfidfVectors, tabs.length);
    assignments = kmeansDense(embeddings, k);
  } else {
    k = estimateK(tfidfVectors, tabs.length);
    assignments = kmeansSpare(tfidfVectors, k);
  }

  // Build clusters
  const clusterMap = new Map<number, number[]>();
  assignments.forEach((cIdx, tabIdx) => {
    const list = clusterMap.get(cIdx) ?? [];
    list.push(tabIdx);
    clusterMap.set(cIdx, list);
  });

  const clusters: Cluster[] = [];
  let colorIdx = 0;

  for (const [, tabIndices] of clusterMap) {
    // Compute centroid TF-IDF for keywords
    const centroidVec = centroidSparse(tabIndices.map((i) => tfidfVectors[i]));
    const keywords = topKeywords(centroidVec, 5);

    // Generate label from most frequent words in tab titles for this cluster
    const clusterTabData = tabIndices.map((i) => tabs[i]);
    const titleWords = clusterTabData
      .flatMap((t) => t.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3))
      .filter((w) => !STOPWORDS.has(w));
    const freq: Record<string, number> = {};
    for (const w of titleWords) freq[w] = (freq[w] ?? 0) + 1;
    const topWords = Object.entries(freq)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([w]) => w);
    const label = topWords.join(" ") || clusterTabData[0]?.title.split(" ").slice(0, 2).join(" ") || "research";

    clusters.push({
      clusterId: crypto.randomUUID(),
      label: label.slice(0, 25),
      color: CLUSTER_COLORS[colorIdx % CLUSTER_COLORS.length],
      tabIds: tabIndices.map((i) => tabs[i].tabId),
      keywords,
      readingOrder: suggestReadingOrder(tabIndices, tabs),
    });
    colorIdx++;
  }

  return clusters;
}

// Session auto-naming: dominant keyword from largest cluster
export function autoNameSession(clusters: Cluster[]): string {
  if (clusters.length === 0) return `Session ${new Date().toLocaleDateString()}`;
  const largest = clusters.reduce((a, b) =>
    a.tabIds.length >= b.tabIds.length ? a : b
  );
  return largest.keywords[0]
    ? largest.keywords.slice(0, 2).join(" ")
    : `Session ${new Date().toLocaleDateString()}`;
}
