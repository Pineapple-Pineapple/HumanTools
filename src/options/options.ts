const app = document.getElementById("app")!;

const heading = document.createElement("h1");
heading.textContent = "Human Tools — Settings";
heading.className = "text-lg font-medium text-neutral-100";

const note = document.createElement("p");
note.className = "text-xs text-neutral-400";
note.textContent =
  "Used only by the Accessibility panel's rewrite call, made from the background service worker. Stored locally on this device — never bundled, never committed.";

const label = document.createElement("label");
label.className = "flex flex-col gap-1 text-sm text-neutral-300";
label.textContent = "OpenRouter API key";

const input = document.createElement("input");
input.type = "password";
input.autocomplete = "off";
input.className = "bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-neutral-100";
label.appendChild(input);

const saveBtn = document.createElement("button");
saveBtn.textContent = "Save";
saveBtn.className =
  "self-start px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-neutral-950 font-medium";

const statusEl = document.createElement("p");
statusEl.className = "text-xs text-neutral-500 min-h-[1em]";

app.append(heading, note, label, saveBtn, statusEl);

chrome.storage.local.get("openrouterApiKey").then(({ openrouterApiKey }) => {
  if (openrouterApiKey) input.value = openrouterApiKey;
});

saveBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ openrouterApiKey: input.value.trim() });
  statusEl.textContent = "Saved.";
});
