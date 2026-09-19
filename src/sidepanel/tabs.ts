export const PANEL_NAMES = [
  "Accessibility",
  "Elements",
  "Network",
  "Memory",
  "Performance",
  "Recorder",
  "Console",
  "Security",
  "Application",
] as const;

const ENABLED_PANEL = "Accessibility";

export function renderTabs(container: HTMLElement): void {
  const strip = document.createElement("div");
  strip.className =
    "flex flex-nowrap overflow-x-auto overflow-y-hidden border-b border-neutral-700 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

  for (const name of PANEL_NAMES) {
    const tab = document.createElement("button");
    tab.textContent = name;
    const isEnabled = name === ENABLED_PANEL;

    if (isEnabled) {
      tab.className =
        "shrink-0 whitespace-nowrap px-3 py-2 border-b-2 border-amber-500 text-neutral-100 font-medium";
    } else {
      tab.disabled = true;
      tab.setAttribute("aria-disabled", "true");
      tab.title = "Not available in this build";
      tab.className = "shrink-0 whitespace-nowrap px-3 py-2 text-neutral-500 opacity-50 cursor-not-allowed";
    }

    strip.appendChild(tab);
  }

  container.appendChild(strip);
}
