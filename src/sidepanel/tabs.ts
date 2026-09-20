export const PANEL_NAMES = ["Accessibility", "Console", "Inspector", "Security", "Application"] as const;
export type PanelName = (typeof PANEL_NAMES)[number];

const ACTIVE_CLASS =
  "shrink-0 whitespace-nowrap px-3 py-2 border-b-2 border-amber-500 text-neutral-100 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60";
const INACTIVE_CLASS =
  "shrink-0 whitespace-nowrap px-3 py-2 border-b-2 border-transparent text-neutral-400 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60";

export function tabId(panel: PanelName): string {
  return `tab-${panel.toLowerCase()}`;
}

export function panelId(panel: PanelName): string {
  return `panel-${panel.toLowerCase()}`;
}

export interface Tabs {
  /** Switches the active tab styling and notifies `onSelect`. */
  select: (panel: PanelName) => void;
}

/**
 * A WAI-ARIA tab strip: one tab stop, arrow keys move between tabs, Home/End jump to the ends.
 * The strip is the first thing keyboard and screen-reader users meet, and it announces which
 * panel is showing — table stakes for an extension that ships an Accessibility panel.
 */
export function renderTabs(container: HTMLElement, onSelect: (panel: PanelName) => void): Tabs {
  const strip = document.createElement("div");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "Human Tools panels");
  strip.className =
    "flex flex-nowrap overflow-x-auto overflow-y-hidden border-b border-neutral-700 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

  const buttons = new Map<PanelName, HTMLButtonElement>();

  function select(panel: PanelName): void {
    for (const [name, btn] of buttons) {
      const active = name === panel;
      btn.className = active ? ACTIVE_CLASS : INACTIVE_CLASS;
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    onSelect(panel);
  }

  function move(from: PanelName, delta: number): void {
    const index = PANEL_NAMES.indexOf(from);
    const next = PANEL_NAMES[(index + delta + PANEL_NAMES.length) % PANEL_NAMES.length];
    select(next);
    buttons.get(next)?.focus();
  }

  for (const name of PANEL_NAMES) {
    const tab = document.createElement("button");
    tab.id = tabId(name);
    tab.textContent = name;
    tab.className = INACTIVE_CLASS;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId(name));
    tab.setAttribute("aria-selected", "false");
    tab.tabIndex = -1;
    tab.addEventListener("click", () => select(name));
    tab.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") move(name, 1);
      else if (e.key === "ArrowLeft") move(name, -1);
      else if (e.key === "Home") {
        select(PANEL_NAMES[0]);
        buttons.get(PANEL_NAMES[0])?.focus();
      } else if (e.key === "End") {
        const last = PANEL_NAMES[PANEL_NAMES.length - 1];
        select(last);
        buttons.get(last)?.focus();
      } else return;
      e.preventDefault();
    });
    buttons.set(name, tab);
    strip.appendChild(tab);
  }

  container.appendChild(strip);

  return { select };
}
