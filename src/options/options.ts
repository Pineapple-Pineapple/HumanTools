import type { Provider } from "../lib/types";

const app = document.getElementById("app")!;

const heading = document.createElement("h1");
heading.textContent = "Human Tools — Settings";
heading.className = "text-lg font-medium text-neutral-100";

const note = document.createElement("p");
note.className = "text-xs text-neutral-400";
note.textContent =
  "Used only by the Accessibility panel's rewrite call, made from the background service worker. Stored locally on this device — never bundled, never committed.";

interface ProviderRow {
  el: HTMLElement;
  radio: HTMLInputElement;
  input: HTMLInputElement;
}

function providerRow(provider: Provider, title: string): ProviderRow {
  const row = document.createElement("div");
  row.className = "flex flex-col gap-1";

  const label = document.createElement("label");
  label.className = "flex items-center gap-2 text-sm text-neutral-300";

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "provider";
  radio.value = provider;

  const titleEl = document.createElement("span");
  titleEl.textContent = title;

  label.append(radio, titleEl);

  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.className = "bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-neutral-100";

  row.append(label, input);
  return { el: row, radio, input };
}

const providerRows: Record<Provider, ProviderRow> = {
  openai: providerRow("openai", "OpenAI"),
  openrouter: providerRow("openrouter", "OpenRouter"),
};

const saveBtn = document.createElement("button");
saveBtn.textContent = "Save";
saveBtn.className =
  "self-start px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-neutral-950 font-medium";

const statusEl = document.createElement("p");
statusEl.className = "text-xs text-neutral-500 min-h-[1em]";

app.append(heading, note, providerRows.openai.el, providerRows.openrouter.el, saveBtn, statusEl);

chrome.storage.local.get(["provider", "openaiApiKey", "openrouterApiKey"]).then((stored) => {
  const provider: Provider = stored.provider === "openrouter" ? "openrouter" : "openai";
  providerRows[provider].radio.checked = true;
  if (stored.openaiApiKey) providerRows.openai.input.value = stored.openaiApiKey;
  if (stored.openrouterApiKey) providerRows.openrouter.input.value = stored.openrouterApiKey;
});

saveBtn.addEventListener("click", async () => {
  const provider: Provider = providerRows.openrouter.radio.checked ? "openrouter" : "openai";
  await chrome.storage.local.set({
    provider,
    openaiApiKey: providerRows.openai.input.value.trim(),
    openrouterApiKey: providerRows.openrouter.input.value.trim(),
  });
  statusEl.textContent = "Saved.";
});
