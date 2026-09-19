import { renderTabs } from "./tabs";
import { renderAccessibilityPanel } from "./accessibility-panel";

const app = document.getElementById("app")!;
renderTabs(app);
renderAccessibilityPanel(app);
