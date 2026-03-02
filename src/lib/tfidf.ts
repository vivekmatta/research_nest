// Pure-JS TF-IDF engine — zero runtime dependencies

export const STOPWORDS = new Set([
  "a","about","above","after","again","against","all","am","an","and","any","are","aren't",
  "as","at","be","because","been","before","being","below","between","both","but","by",
  "can't","cannot","could","couldn't","did","didn't","do","does","doesn't","doing","don't",
  "down","during","each","few","for","from","further","get","got","had","hadn't","has",
  "hasn't","have","haven't","having","he","he'd","he'll","he's","her","here","here's",
  "hers","herself","him","himself","his","how","how's","i","i'd","i'll","i'm","i've","if",
  "in","into","is","isn't","it","it's","its","itself","let's","me","more","most","mustn't",
  "my","myself","no","nor","not","of","off","on","once","only","or","other","ought","our",
  "ours","ourselves","out","over","own","same","shan't","she","she'd","she'll","she's",
  "should","shouldn't","so","some","such","than","that","that's","the","their","theirs",
  "them","themselves","then","there","there's","these","they","they'd","they'll","they're",
  "they've","this","those","through","to","too","under","until","up","very","was","wasn't",
  "we","we'd","we'll","we're","we've","were","weren't","what","what's","when","when's",
  "where","where's","which","while","who","who's","whom","why","why's","will","with",
  "won't","would","wouldn't","you","you'd","you'll","you're","you've","your","yours",
  "yourself","yourselves","http","https","www","com","org","net","html","php","asp",
  "page","click","read","more","also","just","like","use","using","used","new","one",
  "two","may","see","via","per","vs","ie","eg","etc","will","can","set","get","put",
  "may","go","s","re","t","d","ll","m","ve",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function computeTF(tokens: string[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1;
  const max = Math.max(...Object.values(freq), 1);
  const tf: Record<string, number> = {};
  for (const [term, count] of Object.entries(freq)) {
    tf[term] = 0.5 + 0.5 * (count / max); // augmented TF
  }
  return tf;
}

export function computeIDF(
  docs: Record<string, number>[]
): Record<string, number> {
  const N = docs.length;
  const df: Record<string, number> = {};
  for (const doc of docs) {
    for (const term of Object.keys(doc)) {
      df[term] = (df[term] ?? 0) + 1;
    }
  }
  const idf: Record<string, number> = {};
  for (const [term, count] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (count + 1)) + 1; // smoothed IDF
  }
  return idf;
}

export function tfidfVector(
  tf: Record<string, number>,
  idf: Record<string, number>
): Record<string, number> {
  const vec: Record<string, number> = {};
  for (const [term, tfVal] of Object.entries(tf)) {
    if (idf[term] !== undefined) vec[term] = tfVal * idf[term];
  }
  return vec;
}

export function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  let dot = 0, normA = 0, normB = 0;
  for (const [term, val] of Object.entries(a)) {
    if (b[term]) dot += val * b[term];
    normA += val * val;
  }
  for (const val of Object.values(b)) normB += val * val;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function topKeywords(
  vec: Record<string, number>,
  n = 5
): string[] {
  return Object.entries(vec)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term]) => term);
}

// Build TF-IDF vectors for a corpus of tab texts.
// Title is repeated 5x to boost its weight over noisy body content.
export function buildCorpusTFIDF(
  texts: { title: string; body: string }[]
): Record<string, number>[] {
  const tfs = texts.map(({ title, body }) => {
    const combined = [title, title, title, title, title, body].join(" ");
    return computeTF(tokenize(combined));
  });
  const idf = computeIDF(tfs);
  return tfs.map((tf) => tfidfVector(tf, idf));
}
