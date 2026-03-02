// Gemini gemini-embedding-001 API wrapper (replaces text-embedding-004, deprecated Jan 2026)

const EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

export async function getEmbedding(
  text: string,
  apiKey: string
): Promise<number[]> {
  const response = await fetch(`${EMBED_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: text.slice(0, 2000) }] },
      outputDimensionality: 768,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini embedding error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    embedding: { values: number[] };
  };
  return data.embedding.values;
}

export async function batchEmbeddings(
  texts: string[],
  apiKey: string,
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    // Free tier: 15 RPM — add small delay between requests
    if (i > 0) await new Promise((r) => setTimeout(r, 200));
    try {
      const vec = await getEmbedding(texts[i], apiKey);
      results.push(vec);
    } catch {
      results.push([]); // fallback: empty vector, will use TF-IDF
    }
    onProgress?.(i + 1, texts.length);
  }
  return results;
}
