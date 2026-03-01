import "./options.css";
import { getSettings, saveSettings, saveGeminiKey, getGeminiKey } from "../lib/storage.js";
import type { UserSettings } from "../types/index.js";

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;

const geminiKeyInput = $<HTMLInputElement>("gemini-key");
const aiEnabledInput = $<HTMLInputElement>("ai-enabled");
const autoDetectInput = $<HTMLInputElement>("auto-detect");
const thresholdInput = $<HTMLInputElement>("threshold");
const thresholdVal = $<HTMLElement>("threshold-val");
const windowInput = $<HTMLInputElement>("window");
const windowVal = $<HTMLElement>("window-val");
const themeSelect = $<HTMLSelectElement>("theme");
const saveStatus = $<HTMLSpanElement>("save-status");
const keyStatus = $<HTMLSpanElement>("key-status");

// ── Load current settings ─────────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  aiEnabledInput.checked = settings.aiEnabled;
  autoDetectInput.checked = settings.autoDetectEnabled;
  thresholdInput.value = String(settings.detectionThreshold);
  thresholdVal.textContent = String(settings.detectionThreshold);
  windowInput.value = String(settings.detectionWindowMinutes);
  windowVal.textContent = String(settings.detectionWindowMinutes);
  themeSelect.value = settings.theme;

  const key = await getGeminiKey();
  if (key) geminiKeyInput.value = key;
}

// ── Live slider updates ───────────────────────────────────────────────────────

thresholdInput.addEventListener("input", () => {
  thresholdVal.textContent = thresholdInput.value;
});

windowInput.addEventListener("input", () => {
  windowVal.textContent = windowInput.value;
});

// ── Toggle API key visibility ─────────────────────────────────────────────────

$("btn-toggle-key").addEventListener("click", () => {
  const btn = $<HTMLButtonElement>("btn-toggle-key");
  if (geminiKeyInput.type === "password") {
    geminiKeyInput.type = "text";
    btn.textContent = "Hide";
  } else {
    geminiKeyInput.type = "password";
    btn.textContent = "Show";
  }
});

// ── Test API key ──────────────────────────────────────────────────────────────

$("btn-test-key").addEventListener("click", async () => {
  const key = geminiKeyInput.value.trim();
  if (!key) {
    setKeyStatus("Enter an API key first.", "error");
    return;
  }
  setKeyStatus("Testing…", "");
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "models/text-embedding-004",
          content: { parts: [{ text: "test" }] },
        }),
      }
    );
    if (res.ok) {
      setKeyStatus("API key is valid!", "success");
    } else {
      const err = await res.json() as { error?: { message?: string } };
      setKeyStatus(`Error: ${err.error?.message ?? res.status}`, "error");
    }
  } catch {
    setKeyStatus("Network error. Check your connection.", "error");
  }
});

function setKeyStatus(msg: string, type: "" | "success" | "error"): void {
  keyStatus.textContent = msg;
  keyStatus.className = `status-msg ${type}`;
}

// ── Save settings ─────────────────────────────────────────────────────────────

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const key = geminiKeyInput.value.trim();
  if (key) await saveGeminiKey(key);

  const newSettings: Partial<UserSettings> = {
    aiEnabled: aiEnabledInput.checked,
    autoDetectEnabled: autoDetectInput.checked,
    detectionThreshold: parseInt(thresholdInput.value),
    detectionWindowMinutes: parseInt(windowInput.value),
    theme: themeSelect.value as UserSettings["theme"],
  };

  await saveSettings(newSettings);
  setSaveStatus("Settings saved!", "success");
  setTimeout(() => setSaveStatus("", ""), 2000);
});

function setSaveStatus(msg: string, type: "" | "success" | "error"): void {
  saveStatus.textContent = msg;
  saveStatus.className = `status-msg ${type}`;
}

// ── Danger zone ───────────────────────────────────────────────────────────────

$("btn-clear-all").addEventListener("click", async () => {
  if (!confirm("This will permanently delete ALL saved sessions. Are you sure?")) return;
  await chrome.storage.local.remove("rn_sessions");
  setSaveStatus("All sessions deleted.", "success");
  setTimeout(() => setSaveStatus("", ""), 3000);
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadSettings();
