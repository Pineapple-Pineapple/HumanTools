import { PANEL_NAMES, panelId, renderTabs, tabId } from "./tabs";
import type { PanelName } from "./tabs";
import { mountAccessibilityPanel } from "./accessibility-panel";
import { mountConsolePanel } from "./console-panel";
import { mountInspectorPanel } from "./inspector-panel";
import { mountSecurityPanel } from "./security-panel";
import { mountApplicationPanel } from "./application-panel";
import { mountSetupBanner } from "./setup-banner";
import { PANEL_SHOWN_EVENT } from "../lib/panel-visibility";

const app = document.getElementById("app")!;

const panels = {} as Record<PanelName, HTMLElement>;
for (const name of PANEL_NAMES) {
  const container = document.createElement("div");
  // Console runs its own scroller for the transcript; every other panel scrolls as a whole.
  container.className = name === "Console" ? "flex-1 min-h-0 overflow-hidden" : "flex-1 min-h-0 overflow-y-auto";
  container.id = panelId(name);
  container.setAttribute("role", "tabpanel");
  container.setAttribute("aria-labelledby", tabId(name));
  container.hidden = true;
  panels[name] = container;
}

const LAST_PANEL_KEY = "lastPanel";

const { select } = renderTabs(app, (panel) => {
  for (const name of PANEL_NAMES) {
    const container = panels[name];
    const showing = name === panel;
    const wasHidden = container.hidden;
    container.hidden = !showing;
    // Panels defer their automatic work while hidden; this is how they learn to catch up.
    if (showing && wasHidden) container.dispatchEvent(new CustomEvent(PANEL_SHOWN_EVENT));
  }
  chrome.storage.local.set({ [LAST_PANEL_KEY]: panel });
});

mountSetupBanner(app);
app.append(...PANEL_NAMES.map((name) => panels[name]));

mountAccessibilityPanel(panels.Accessibility);
mountConsolePanel(panels.Console);
mountInspectorPanel(panels.Inspector, { activate: () => select("Inspector") });
mountSecurityPanel(panels.Security);
mountApplicationPanel(panels.Application);

// Reopen on the panel the reader left. Nothing is selected until storage answers: selecting a
// default first would fire the callback above and overwrite the very value being read back.
function isPanelName(value: unknown): value is PanelName {
  return typeof value === "string" && (PANEL_NAMES as readonly string[]).includes(value);
}
chrome.storage.local
  .get(LAST_PANEL_KEY)
  .then(({ lastPanel }) => (isPanelName(lastPanel) ? lastPanel : "Accessibility"))
  .catch((): PanelName => "Accessibility")
  .then(select);
