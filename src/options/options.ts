import type { Provider } from "../lib/types";

type StoredKey = "openaiApiKey" | "openrouterApiKey" | "gptzeroApiKey" | "sourceTracerUrl";

const STORED_KEYS: StoredKey[] = ["openaiApiKey", "openrouterApiKey", "gptzeroApiKey", "sourceTracerUrl"];
const PROVIDERS: Provider[] = ["openai", "openrouter"];

const README_TRACER_URL = "https://github.com/Pineapple-Pineapple/HumanTools#source-tracer-worker";

const INPUT_CLASS = "w-full bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-neutral-100";
const LABEL_CLASS = "text-sm text-neutral-300";
const HINT_CLASS = "text-xs text-muted";
const SECONDARY_BUTTON_CLASS =
  "px-2 py-1 border border-neutral-600 rounded text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el("a", "text-amber-400 underline hover:text-amber-300", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

interface Field {
  el: HTMLElement;
  input: HTMLInputElement;
}

/** A labelled input with its hint wired up via aria-describedby. */
function field(opts: {
  key: StoredKey;
  label: string;
  type: "password" | "url";
  hint: (string | Node)[];
  placeholder?: string;
}): Field {
  const label = el("label", LABEL_CLASS, opts.label);
  label.htmlFor = opts.key;

  const hint = el("p", HINT_CLASS, ...opts.hint);
  hint.id = `${opts.key}-hint`;

  const input = el("input", INPUT_CLASS);
  input.id = opts.key;
  input.type = opts.type;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-describedby", hint.id);
  if (opts.placeholder) input.placeholder = opts.placeholder;

  return { el: el("div", "flex flex-col gap-1", label, hint, input), input };
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

interface ProviderSpec {
  title: string;
  /** One clause on what the provider is, for people who don't already know. */
  blurb?: string;
  keysUrl: string;
  keysHost: string;
  /** A free, read-only endpoint that answers 401 for a bad key; nothing is generated or billed. */
  test: { url: string; host: string; what: string };
}

const PROVIDER_SPECS: Record<Provider, ProviderSpec> = {
  openai: {
    title: "OpenAI",
    keysUrl: "https://platform.openai.com/api-keys",
    keysHost: "platform.openai.com/api-keys",
    test: { url: "https://api.openai.com/v1/models", host: "api.openai.com", what: "asks for its model list" },
  },
  openrouter: {
    title: "OpenRouter",
    blurb: "one key for many models",
    keysUrl: "https://openrouter.ai/keys",
    keysHost: "openrouter.ai/keys",
    test: { url: "https://openrouter.ai/api/v1/auth/key", host: "openrouter.ai", what: "asks what the key is allowed to do" },
  },
};

interface ProviderRow {
  el: HTMLElement;
  radio: HTMLInputElement;
  input: HTMLInputElement;
}

async function testKey(spec: ProviderSpec, key: string): Promise<string> {
  const { url, host } = spec.test;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    return `Couldn't reach ${host}.`;
  }
  if (res.ok) return "Key accepted.";
  if (res.status === 401) return `${host} rejected this key (401).`;
  return `${host} answered ${res.status}.`;
}

function providerRow(provider: Provider): ProviderRow {
  const spec = PROVIDER_SPECS[provider];
  const storedKey: StoredKey = `${provider}ApiKey`;

  const radio = el("input", "");
  radio.type = "radio";
  radio.name = "provider";
  radio.value = provider;
  radio.id = `provider-${provider}`;

  const radioLabel = el("label", "text-sm font-medium text-neutral-100", spec.title);
  radioLabel.htmlFor = radio.id;

  const header = el("div", "flex items-center gap-2", radio, radioLabel);
  if (spec.blurb) header.append(el("span", HINT_CLASS, `— ${spec.blurb}`));

  const keyField = field({
    key: storedKey,
    label: `${spec.title} API key`,
    type: "password",
    hint: ["Get one at ", link(spec.keysUrl, spec.keysHost), "."],
  });

  // Filling in a key is the clearest signal of which provider the user means to use.
  keyField.input.addEventListener("input", () => {
    if (keyField.input.value.trim()) radio.checked = true;
  });

  const testBtn = el("button", SECONDARY_BUTTON_CLASS, "Test key");
  testBtn.type = "button";
  const testStatus = el("span", HINT_CLASS);
  testStatus.setAttribute("role", "status");
  const testHint = el(
    "p",
    HINT_CLASS,
    `Test sends only this key, as typed, to ${spec.test.host} and ${spec.test.what}. Nothing is generated, billed or saved.`,
  );

  testBtn.addEventListener("click", async () => {
    const key = keyField.input.value.trim();
    if (!key) {
      testStatus.textContent = "Enter a key first.";
      return;
    }
    testBtn.disabled = true;
    testStatus.textContent = "Testing…";
    testStatus.textContent = await testKey(spec, key);
    testBtn.disabled = false;
  });
  keyField.input.addEventListener("input", () => {
    testStatus.textContent = "";
  });

  const row = el(
    "div",
    "flex flex-col gap-2",
    header,
    keyField.el,
    el("div", "flex items-center gap-2", testBtn, testStatus),
    testHint,
  );
  return { el: row, radio, input: keyField.input };
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

const app = document.getElementById("app")!;

const heading = el("h1", "text-lg font-medium text-neutral-100", "Human Tools — Settings");

const note = el(
  "p",
  "text-xs text-neutral-400",
  "Used by the Accessibility, Console and Inspector panels. Your keys stay on this device and are sent only to the service each one belongs to. Nothing about your browsing is sent anywhere until you press a button in the panel that says it will.",
);

const providerRows: Record<Provider, ProviderRow> = {
  openai: providerRow("openai"),
  openrouter: providerRow("openrouter"),
};

const providerSet = el("fieldset", "flex flex-col gap-4 pt-3 border-t border-neutral-800");
providerSet.append(
  el("legend", `${LABEL_CLASS} pb-2`, "Provider — the panels use whichever one is selected"),
  providerRows.openai.el,
  providerRows.openrouter.el,
);

const gptzeroField = field({
  key: "gptzeroApiKey",
  label: "GPTZero API key (optional)",
  type: "password",
  hint: [
    "Turns on the Inspector's Slop Check, which sends the inspected passage to GPTZero for an AI-text probability. Get one from the ",
    link("https://app.gptzero.me/app/api", "GPTZero dashboard"),
    ".",
  ],
});
gptzeroField.el.classList.add("pt-3", "border-t", "border-neutral-800");

const sourceTracerField = field({
  key: "sourceTracerUrl",
  label: "Source Tracer endpoint (optional)",
  type: "url",
  placeholder: "https://…workers.dev/v1/trace",
  hint: [
    "There is no shared Source Tracer service: this is the URL of a Cloudflare Worker you deploy yourself, following the ",
    link(README_TRACER_URL, "Source Tracer Worker section of the README"),
    ". Search and browsing credentials live on that Worker, not in this extension. Without it, Inspector still works but external sources show “Not checked”.",
  ],
});
sourceTracerField.el.classList.add("pt-3", "border-t", "border-neutral-800");

const saveBtn = el(
  "button",
  "self-start px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-neutral-950 font-medium",
  "Save",
);
saveBtn.type = "button";

const statusEl = el("p", `${HINT_CLASS} min-h-[1em]`);
statusEl.setAttribute("role", "status");

app.append(heading, note, providerSet, gptzeroField.el, sourceTracerField.el, saveBtn, statusEl);

// ---------------------------------------------------------------------------------------------
// Load and save
// ---------------------------------------------------------------------------------------------

const inputs: Record<StoredKey, HTMLInputElement> = {
  openaiApiKey: providerRows.openai.input,
  openrouterApiKey: providerRows.openrouter.input,
  gptzeroApiKey: gptzeroField.input,
  sourceTracerUrl: sourceTracerField.input,
};

/** What storage held when the page loaded (or last saved), so Save can write only what changed. */
let storedValues: Partial<Record<StoredKey, string>> = {};
let storedProvider: Provider | null = null;

function selectedProvider(): Provider {
  return providerRows.openrouter.radio.checked ? "openrouter" : "openai";
}

chrome.storage.local.get(["provider", ...STORED_KEYS]).then((stored) => {
  for (const key of STORED_KEYS) {
    if (typeof stored[key] === "string" && stored[key]) {
      storedValues[key] = stored[key];
      inputs[key].value = stored[key];
    }
  }
  if (stored.provider === "openai" || stored.provider === "openrouter") storedProvider = stored.provider;
  providerRows[storedProvider ?? "openai"].radio.checked = true;
});

// Any edit after a save makes "Saved." a lie, so drop it.
app.addEventListener("input", () => {
  statusEl.textContent = "";
});
app.addEventListener("change", () => {
  statusEl.textContent = "";
});

saveBtn.addEventListener("click", async () => {
  const values = Object.fromEntries(STORED_KEYS.map((key) => [key, inputs[key].value.trim()])) as Record<
    StoredKey,
    string
  >;

  // provider.ts ignores anything that isn't https, which would otherwise fail silently as "Not checked".
  if (values.sourceTracerUrl && !values.sourceTracerUrl.startsWith("https://")) {
    statusEl.textContent = "Not saved: the Source Tracer endpoint must start with https://.";
    sourceTracerField.input.focus();
    return;
  }

  // With exactly one key filled in, that provider is the only one that can work, whatever the radio says.
  const keyed = PROVIDERS.filter((p) => values[`${p}ApiKey`]);
  const provider = keyed.length === 1 ? keyed[0] : selectedProvider();
  providerRows[provider].radio.checked = true;

  const set: Partial<Record<StoredKey | "provider", string>> = {};
  const remove: StoredKey[] = [];
  for (const key of STORED_KEYS) {
    if (values[key] === (storedValues[key] ?? "")) continue;
    if (values[key]) set[key] = values[key];
    else remove.push(key);
  }
  if (provider !== storedProvider) set.provider = provider;

  if (Object.keys(set).length === 0 && remove.length === 0) {
    statusEl.textContent = "Nothing changed.";
    return;
  }

  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (remove.length) await chrome.storage.local.remove(remove);

  storedValues = Object.fromEntries(Object.entries(values).filter(([, v]) => v));
  storedProvider = provider;
  statusEl.textContent = "Saved.";
});
