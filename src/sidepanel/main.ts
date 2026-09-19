import { renderTabs } from "./tabs";
import { mountAccessibilityPanel } from "./accessibility-panel";
import { mountConsolePanel } from "./console-panel";
import { mountInspectorPanel } from "./inspector-panel";
import { mountSecurityPanel } from "./security-panel";
import { mountApplicationPanel } from "./application-panel";
import { mountNetworkPanel } from "./network-panel";
import { PANEL_SHOWN_EVENT } from "../lib/panel-visibility";

const app = document.getElementById("app")!;

const accessibilityContainer = document.createElement("div");
accessibilityContainer.className = "flex-1 min-h-0 overflow-y-auto";

const consoleContainer = document.createElement("div");
consoleContainer.className = "flex-1 min-h-0 overflow-hidden";

const inspectorContainer = document.createElement("div");
inspectorContainer.className = "flex-1 min-h-0 overflow-y-auto";

const networkContainer = document.createElement("div");
networkContainer.className = "flex-1 min-h-0 overflow-y-auto";

const securityContainer = document.createElement("div");
securityContainer.className = "flex-1 min-h-0 overflow-y-auto";

const applicationContainer = document.createElement("div");
applicationContainer.className = "flex-1 min-h-0 overflow-y-auto";

const panels: Record<string, HTMLElement> = {
  Accessibility: accessibilityContainer,
  Console: consoleContainer,
  Inspector: inspectorContainer,
  Network: networkContainer,
  Security: securityContainer,
  Application: applicationContainer,
};

const LAST_PANEL_KEY = "lastPanel";

const { select } = renderTabs(app, (panel) => {
  for (const [name, el] of Object.entries(panels)) {
    const showing = name === panel;
    const wasHidden = el.hidden;
    el.hidden = !showing;
    // Panels defer their automatic work while hidden; this is how they learn to catch up.
    if (showing && wasHidden) el.dispatchEvent(new CustomEvent(PANEL_SHOWN_EVENT));
  }
  chrome.storage.local.set({ [LAST_PANEL_KEY]: panel });
});

app.append(accessibilityContainer, consoleContainer, inspectorContainer, networkContainer, securityContainer, applicationContainer);
mountAccessibilityPanel(accessibilityContainer);
mountConsolePanel(consoleContainer);
mountInspectorPanel(inspectorContainer, { activate: () => select("Inspector") });
mountNetworkPanel(networkContainer);
mountSecurityPanel(securityContainer);
mountApplicationPanel(applicationContainer);

// Reopen on the panel the reader left. Nothing is selected until storage answers: selecting a
// default first would fire the callback above and overwrite the very value being read back.
for (const el of Object.values(panels)) el.hidden = true;
chrome.storage.local
  .get(LAST_PANEL_KEY)
  .then(({ lastPanel }) => (typeof lastPanel === "string" && lastPanel in panels ? lastPanel : "Accessibility"))
  .catch(() => "Accessibility")
  .then(select);
