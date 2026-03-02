// AI summarization via Gemini gemini-1.5-flash + offline sentence scoring fallback

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

export interface SummaryResult {
  bullets: string[];
  source: "ai" | "offline";
}

// ── AI path ───────────────────────────────────────────────────────────────────

export async function summarizeWithAI(
  tab: { title: string; metaDescription: string; headings: string[]; bodySnippet: string },
  apiKey: string
): Promise<SummaryResult> {
  const context = [
    `Title: ${tab.title}`,
    tab.metaDescription ? `Description: ${tab.metaDescription}` : "",
    tab.headings.length ? `Headings: ${tab.headings.slice(0, 8).join(", ")}` : "",
    tab.bodySnippet ? `Content: ${tab.bodySnippet.slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `Summarize the following web page content in exactly 3-5 bullet points. Each bullet should be a complete, informative sentence. Return only the bullets, one per line, starting with "- ".

${context}`;

  const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 512,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini summarization error ${response.status}`);
  }

  const data = await response.json() as {
    candidates: { content: { parts: { text: string }[] } }[];
  };

  const text = data.candidates[0]?.content.parts[0]?.text ?? "";
  const bullets = text
    .split("\n")
    .map((l: string) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l: string) => l.length > 10)
    .slice(0, 5);

  return { bullets, source: "ai" };
}

// ── Session-level AI summary ──────────────────────────────────────────────────

export async function summarizeSession(
  title: string,
  clusterLabels: string[],
  tabTitles: string[],
  apiKey: string
): Promise<{
  summary: string;
  takeaways: string[];
  openQuestions: string[];
}> {
  const prompt = `You are helping a researcher understand a research session.

Session title: ${title}
Topics/clusters: ${clusterLabels.join(", ")}
Pages visited: ${tabTitles.slice(0, 20).join("; ")}

Provide:
1. A 2-3 sentence overall summary
2. 3-5 key takeaways (start each with "TAKEAWAY: ")
3. 2-3 open questions to explore further (start each with "QUESTION: ")`;

  const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
    }),
  });

  if (!response.ok) throw new Error(`Gemini session summary error ${response.status}`);

  const data = await response.json() as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  const text = data.candidates[0]?.content.parts[0]?.text ?? "";
  const lines = text.split("\n").map((l: string) => l.trim()).filter(Boolean);

  const summaryLines: string[] = [];
  const takeaways: string[] = [];
  const openQuestions: string[] = [];

  for (const line of lines) {
    if (line.startsWith("TAKEAWAY:")) {
      takeaways.push(line.replace("TAKEAWAY:", "").trim());
    } else if (line.startsWith("QUESTION:")) {
      openQuestions.push(line.replace("QUESTION:", "").trim());
    } else if (summaryLines.length < 3) {
      summaryLines.push(line);
    }
  }

  return {
    summary: summaryLines.join(" "),
    takeaways,
    openQuestions,
  };
}

// ── Offline path ──────────────────────────────────────────────────────────────

// Score sentences by position + keyword density
function scoreOffline(
  tab: { title: string; metaDescription: string; headings: string[]; bodySnippet: string }
): string[] {
  const combined = [tab.metaDescription, tab.bodySnippet].filter(Boolean).join(". ");
  const sentences = combined
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.split(" ").length >= 5)
    .slice(0, 20);

  if (sentences.length === 0) {
    const parts: string[] = [];
    if (tab.title) parts.push(`Page: ${tab.title}`);
    tab.headings.slice(0, 3).forEach((h) => parts.push(`Topic: ${h}`));
    return parts.slice(0, 3);
  }

  const titleWords = new Set(tab.title.toLowerCase().split(/\s+/));
  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().split(/\s+/);
    const overlap = words.filter((w) => titleWords.has(w)).length;
    const posScore = i === 0 ? 2 : 1 / (i + 1);
    return { s, score: overlap * 0.6 + posScore * 0.4 };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ s }) => s);
}

export async function summarizeTab(
  tab: { title: string; metaDescription: string; headings: string[]; bodySnippet: string },
  apiKey: string | null,
  aiEnabled: boolean
): Promise<SummaryResult> {
  if (aiEnabled && apiKey) {
    try {
      return await summarizeWithAI(tab, apiKey);
    } catch {
      // fall through to offline
    }
  }
  return { bullets: scoreOffline(tab), source: "offline" };
}
