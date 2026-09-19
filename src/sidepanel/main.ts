import { renderTabs } from "./tabs";
import { mountAccessibilityPanel } from "./accessibility-panel";

const app = document.getElementById("app")!;
renderTabs(app);
mountAccessibilityPanel(app);
