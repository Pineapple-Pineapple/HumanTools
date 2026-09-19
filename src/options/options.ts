import type { Provider } from "../lib/types";

const app = document.getElementById("app")!;

const heading = document.createElement("h1");
heading.textContent = "Human Tools — Settings";
heading.className = "text-lg font-medium text-neutral-100";

const note = document.createElement("p");
note.className = "text-xs text-neutral-400";
note.textContent =
  "Used by the Accessibility, Console and Inspector panels. Every call is made from the background service worker. Keys are stored locally on this device — never bundled, never committed.";

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

const gptzeroRow = document.createElement("label");
gptzeroRow.className = "flex flex-col gap-1 text-sm text-neutral-300 pt-3 border-t border-neutral-800";
const gptzeroTitle = document.createElement("span");
gptzeroTitle.textContent = "GPTZero API key (optional)";
const gptzeroHint = document.createElement("span");
gptzeroHint.className = "text-xs text-neutral-500";
gptzeroHint.textContent =
  "Enables the Inspector's Slop Check, which sends the inspected passage to GPTZero for an AI-text probability.";
const gptzeroInput = document.createElement("input");
gptzeroInput.type = "password";
gptzeroInput.autocomplete = "off";
gptzeroInput.className = "bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-neutral-100";
gptzeroRow.append(gptzeroTitle, gptzeroHint, gptzeroInput);

const sourceTracerRow = document.createElement("label");
sourceTracerRow.className = "flex flex-col gap-1 text-sm text-neutral-300 pt-3 border-t border-neutral-800";
const sourceTracerTitle = document.createElement("span");
sourceTracerTitle.textContent = "Source Tracer endpoint (optional)";
const sourceTracerHint = document.createElement("span");
sourceTracerHint.className = "text-xs text-neutral-500";
sourceTracerHint.textContent = "Cloudflare Worker URL for independently finding and checking primary sources. Vendor credentials stay on the Worker.";
const sourceTracerInput = document.createElement("input");
sourceTracerInput.type = "url";
sourceTracerInput.placeholder = "https://…workers.dev/v1/trace";
sourceTracerInput.autocomplete = "off";
sourceTracerInput.className = "bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-neutral-100";
sourceTracerRow.append(sourceTracerTitle, sourceTracerHint, sourceTracerInput);

const saveBtn = document.createElement("button");
saveBtn.textContent = "Save";
saveBtn.className =
  "self-start px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-neutral-950 font-medium";

const statusEl = document.createElement("p");
statusEl.className = "text-xs text-neutral-500 min-h-[1em]";

app.append(heading, note, providerRows.openai.el, providerRows.openrouter.el, gptzeroRow, sourceTracerRow, saveBtn, statusEl);

chrome.storage.local.get(["provider", "openaiApiKey", "openrouterApiKey", "gptzeroApiKey", "sourceTracerUrl"]).then((stored) => {
  const provider: Provider = stored.provider === "openrouter" ? "openrouter" : "openai";
  providerRows[provider].radio.checked = true;
  if (stored.openaiApiKey) providerRows.openai.input.value = stored.openaiApiKey;
  if (stored.openrouterApiKey) providerRows.openrouter.input.value = stored.openrouterApiKey;
  if (stored.gptzeroApiKey) gptzeroInput.value = stored.gptzeroApiKey;
  if (stored.sourceTracerUrl) sourceTracerInput.value = stored.sourceTracerUrl;
});

saveBtn.addEventListener("click", async () => {
  const provider: Provider = providerRows.openrouter.radio.checked ? "openrouter" : "openai";
  await chrome.storage.local.set({
    provider,
    openaiApiKey: providerRows.openai.input.value.trim(),
    openrouterApiKey: providerRows.openrouter.input.value.trim(),
    gptzeroApiKey: gptzeroInput.value.trim(),
    sourceTracerUrl: sourceTracerInput.value.trim(),
  });
  statusEl.textContent = "Saved.";
});
