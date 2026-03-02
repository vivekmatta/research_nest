// Content script — extracts page metadata and sends to background
// Wrapped in IIFE so re-injection doesn't cause "already declared" SyntaxError

import type { ContentScriptMessage } from "../types/index.js";

(() => {
  function getMainElement(): Element {
    return (
      document.querySelector("article") ??
      document.querySelector("main") ??
      document.querySelector("[role=main]") ??
      document.body
    );
  }

  function extractHeadings(): string[] {
    return Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((h) => h.textContent?.trim() ?? "")
      .filter((t) => t.length > 0)
      .slice(0, 15);
  }

  function extractBodySnippet(): string {
    const main = getMainElement();
    const text = (main as HTMLElement).innerText ?? main.textContent ?? "";
    return text.replace(/\s+/g, " ").trim().slice(0, 600);
  }

  function extractMetaDescription(): string {
    const metaEl =
      document.querySelector('meta[name="description"]') ??
      document.querySelector('meta[property="og:description"]');
    return (metaEl as HTMLMetaElement)?.content?.trim() ?? "";
  }

  const msg: ContentScriptMessage = {
    type: "PAGE_CONTENT",
    payload: {
      title: document.title.trim(),
      metaDescription: extractMetaDescription(),
      headings: extractHeadings(),
      bodySnippet: extractBodySnippet(),
    },
  };

  chrome.runtime.sendMessage(msg).catch(() => {
    // Extension may have reloaded; ignore
  });
})();
