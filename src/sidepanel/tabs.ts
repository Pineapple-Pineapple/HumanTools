export const PANEL_NAMES = ["Accessibility", "Console", "Inspector", "Security", "Application"] as const;

const ACTIVE_CLASS = "shrink-0 whitespace-nowrap px-3 py-2 border-b-2 border-amber-500 text-neutral-100 font-medium";
const INACTIVE_CLASS =
  "shrink-0 whitespace-nowrap px-3 py-2 border-b-2 border-transparent text-neutral-400 hover:text-neutral-200";

export interface Tabs {
  /** Switches the active tab styling and notifies `onSelect`. */
  select: (panel: string) => void;
}

export function renderTabs(container: HTMLElement, onSelect: (panel: string) => void): Tabs {
  const strip = document.createElement("div");
  strip.className =
    "flex flex-nowrap overflow-x-auto overflow-y-hidden border-b border-neutral-700 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

  const buttons = new Map<string, HTMLButtonElement>();

  function select(panel: string): void {
    for (const [name, btn] of buttons) {
      btn.className = name === panel ? ACTIVE_CLASS : INACTIVE_CLASS;
    }
    onSelect(panel);
  }

  for (const name of PANEL_NAMES) {
    const tab = document.createElement("button");
    tab.textContent = name;
    tab.className = INACTIVE_CLASS;
    tab.addEventListener("click", () => select(name));
    buttons.set(name, tab);
    strip.appendChild(tab);
  }

  container.appendChild(strip);

  return { select };
}
