import { renderTabs } from "./tabs";
import { mountAccessibilityPanel } from "./accessibility-panel";
import { mountConsolePanel } from "./console-panel";
import { mountInspectorPanel } from "./inspector-panel";

const app = document.getElementById("app")!;

const accessibilityContainer = document.createElement("div");
accessibilityContainer.className = "flex-1 min-h-0 overflow-y-auto";

const consoleContainer = document.createElement("div");
consoleContainer.className = "flex-1 min-h-0 overflow-hidden";

const inspectorContainer = document.createElement("div");
inspectorContainer.className = "flex-1 min-h-0 overflow-y-auto";

const panels: Record<string, HTMLElement> = {
  Accessibility: accessibilityContainer,
  Console: consoleContainer,
  Inspector: inspectorContainer,
};

const { select } = renderTabs(app, (panel) => {
  for (const [name, el] of Object.entries(panels)) el.hidden = name !== panel;
});

app.append(accessibilityContainer, consoleContainer, inspectorContainer);
mountAccessibilityPanel(accessibilityContainer);
mountConsolePanel(consoleContainer);
mountInspectorPanel(inspectorContainer, { activate: () => select("Inspector") });
select("Accessibility");
