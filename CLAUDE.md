# ResearchNest — Project Guide for Claude

## What This Project Is

ResearchNest is a Chrome Extension (MV3) that automatically detects research sessions, clusters open tabs by topic using TF-IDF and k-means++ clustering, and creates a structured, searchable archive of those sessions. It integrates with the Google Gemini API (free tier) for AI-powered summaries and embeddings, with a full offline fallback.

---

## Git Workflow — Always Follow This

**Every meaningful change must be committed and pushed.** This keeps a full version history so we can roll back at any time.

### Rules
- Commit after every logical unit of work (a feature, a bug fix, a refactor — not every file save)
- Always push to remote after committing: `git push`
- Never batch unrelated changes into a single commit
- Never force-push to main/master
- Write clear, descriptive commit messages (see format below)

### Commit message format
```
<type>: <short summary>

<optional body explaining why, not what>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**Types:**
- `feat` — new feature
- `fix` — bug fix
- `refactor` — code restructure with no behavior change
- `style` — CSS/UI changes only
- `chore` — config, build, dependencies
- `docs` — documentation only

### Examples
```
feat: add duplicate tab badge in dashboard cluster cards
fix: service worker fails to restart after Chrome idle kill
refactor: extract dwell time logic into separate module
style: update popup active-session stats grid spacing
chore: bump @types/chrome to latest
```

### Workflow per change
```bash
# 1. Make your changes
# 2. Build to verify no errors
npm run build
npx tsc --noEmit

# 3. Stage specific files (not git add -A blindly)
git add src/lib/clustering.ts src/background/service-worker.ts

# 4. Commit with a clear message
git commit -m "feat: improve k-means++ elbow threshold for small tab sets"

# 5. Push immediately
git push
```

---

## Project Plan & Feature Checklist

### Core Features (Implemented in v1.0)
- [x] Auto-detect research sessions (configurable: default 8 tabs / 5 min window)
- [x] Content script extracts title, meta description, headings (h1–h3), body snippet
- [x] Pure-JS TF-IDF engine with stopword filtering and title boosting (3×)
- [x] K-means++ clustering with elbow-method auto-K selection (k=2–6)
- [x] Gemini `text-embedding-004` for AI embeddings (768-dim)
- [x] Gemini `gemini-1.5-flash` for tab summaries and session insights
- [x] Full offline fallback (sentence scoring by position + keyword overlap)
- [x] Chrome Tab Groups API: colored groups with keyword labels
- [x] Duplicate tab detection (same domain + cosine similarity > 0.85)
- [x] Dwell time tracking per tab via `chrome.tabs.onActivated`
- [x] Session auto-naming from dominant cluster keyword
- [x] Reading order suggestion by URL path depth
- [x] Cross-session search (title, tab titles, keywords)
- [x] Dashboard: session list, cluster grid, hover cards with on-demand summaries
- [x] Markdown export with full session structure
- [x] Options: detection thresholds (sliders), Gemini API key (XOR-obfuscated), theme
- [x] Storage quota warning at 8MB
- [x] MV3 service worker persistence via `chrome.storage.session` + `chrome.alarms`
- [x] Keyboard shortcuts: `Ctrl+Shift+R` (popup), `Ctrl+Shift+D` (dashboard), `Ctrl+Shift+E` (export)

### Known Improvements To Build Next
- [ ] Tag sessions with custom labels (in addition to auto-name)
- [ ] Pin important tabs within a cluster
- [ ] Export to JSON (for re-import)
- [ ] Session merge (combine two related sessions)
- [ ] Cluster rename inline in dashboard
- [ ] Notification when AI summary generation completes in background
- [ ] Per-cluster reading progress tracker (mark tabs as read)

---

## Chrome Web Store Submission — Progress Log

### Status: Submitted for review (awaiting approval)

### What has been done

#### Build & packaging
- [x] `npm run build` — clean build, 17 modules, no errors
- [x] `dist/` folder zipped as `researchnest.zip` and uploaded to the Web Store dashboard
- [x] Remote repo configured: `git@github.com:vivekmatta/research_nest.git`
- [x] All commits pushed to `origin/master`

#### Store listing
- [x] Store icon (128×128 PNG) — generated via `generate-store-assets.html`
- [x] 5 screenshots (640×400 PNG, no alpha) — generated via `generate-store-assets.html`
  - Screenshot 1: Dashboard cluster view
  - Screenshot 2: Popup active session
  - Screenshot 3: Session archive
  - Screenshot 4: AI summary & tab detail
  - Screenshot 5: Settings page
- [x] Publisher declared as **non-trader** (personal/hobby project, no commercial intent)

#### Privacy practices tab (required before submission)
- [x] Single purpose description submitted
- [x] Permission justifications written and submitted for all 9 permissions:
  `tabs`, `tabGroups`, `storage`, `scripting`, `alarms`, `notifications`,
  `activeTab`, `downloads`, `host_permissions (<all_urls>)`
- [x] Remote code justification submitted (extension uses no remote code; Gemini API calls only)
- [x] Data usage disclosures certified:
  - Collects: authentication info (API key, local only), web history (tab URLs/titles), user activity (dwell time), website content (page text for clustering)
  - Does NOT collect: PII, health, financial, location, personal communications
  - All three policy certifications checked
- [x] Privacy policy drafted (Markdown) — to be hosted as a public GitHub Gist
- [x] Contact email added and verified on Account tab

#### Known review flags
- **Broad host permissions warning**: `<all_urls>` triggers an in-depth review delay.
  This is expected and justified — the extension must inject content scripts into
  any tab the user researches, and sites cannot be predicted in advance.
  Justification was submitted in the Privacy practices form.

### How to update the extension after publishing
1. Make code changes
2. `npm run build && npx tsc --noEmit`
3. Bump version in `public/manifest.json` (e.g. `1.0.0` → `1.0.1`)
4. `git commit` + `git push`
5. Zip `dist/`: `powershell -Command "Compress-Archive -Path dist\* -DestinationPath researchnest.zip -Force"`
6. Upload new ZIP in Web Store dashboard → Package tab → Submit for review

---

## Architecture

### Build
- **Vite + TypeScript** — multi-entry rollup config, outputs to `dist/`
- `npm run build` — production build
- `npx tsc --noEmit` — type-check only
- Zero runtime dependencies (only `@types/chrome` as devDep)

### Entry Points
| Entry | Output | Purpose |
|---|---|---|
| `src/background/service-worker.ts` | `dist/background/service-worker.js` | Tab monitoring, session orchestration |
| `src/content/content-script.ts` | `dist/content/content-script.js` | Page content extraction |
| `src/popup/popup.ts` | `dist/popup/popup.js` | Extension popup (3 states) |
| `src/dashboard/dashboard.ts` | `dist/dashboard/dashboard.js` | Full session dashboard |
| `src/options/options.ts` | `dist/options/options.js` | Settings page |

### Key Libraries (all pure JS, no npm packages)
| File | Purpose |
|---|---|
| `src/lib/storage.ts` | `chrome.storage` CRUD + API key obfuscation |
| `src/lib/tfidf.ts` | TF-IDF tokenization, IDF, cosine similarity |
| `src/lib/clustering.ts` | K-means++, elbow method, duplicate detection, reading order |
| `src/lib/embeddings.ts` | Gemini `text-embedding-004` API wrapper |
| `src/lib/summarizer.ts` | Gemini `gemini-1.5-flash` + offline sentence scoring |
| `src/lib/tab-groups.ts` | Chrome Tab Groups API (skips non-groupable tabs) |
| `src/lib/exporter.ts` | Markdown export formatter |

### Data Flow
```
Tab opened
  → service-worker records event in chrome.storage.session
  → if threshold reached: notification prompt
  → user confirms → startSession()
    → injects content-script into all open tabs
    → content-script sends PAGE_CONTENT message
    → service-worker updates TabData in ResearchSession
  → user clicks "End & Cluster"
    → endSession() flushes dwell times
    → buildCorpusTFIDF() on all tabs
    → (optional) batchEmbeddings() via Gemini API
    → clusterTabs() → k-means++ assignments
    → createTabGroups() → Chrome visual groups
    → autoNameSession() → session title
    → (optional) summarizeSession() via Gemini API
    → saveSession() to chrome.storage.local
```

### MV3 Service Worker Gotcha
Service workers are **ephemeral** — Chrome kills them when idle. Never hold state in memory only.

```typescript
// CORRECT pattern for every handler:
chrome.tabs.onCreated.addListener(async (tab) => {
  const state = await storage.getDetectionState(); // read from storage.session
  // mutate...
  await storage.saveDetectionState(state);          // write back
});

// Alarm keeps the worker alive for periodic tasks
chrome.alarms.create("prune-window", { periodInMinutes: 1 });
```

### Storage Layout
| Key | Storage area | Contents |
|---|---|---|
| `rn_sessions` | `chrome.storage.local` | `ResearchSession[]` |
| `rn_settings` | `chrome.storage.local` | `UserSettings` (incl. obfuscated API key) |
| `rn_detection` | `chrome.storage.session` | `SessionDetectionState` (ephemeral) |

---

## Loading the Extension

1. `npm run build`
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `dist/` folder
5. After any code change: `npm run build` → click **↺** (refresh) in `chrome://extensions`

## Getting a Free Gemini API Key

1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Sign in with Google — no credit card needed
3. Click **Create API key**
4. Paste it in ResearchNest → Settings → Gemini API Key → Save
5. Click **Test** to verify it works

Free tier limits: 15 requests/min, 1M tokens/day — more than enough for personal use.
