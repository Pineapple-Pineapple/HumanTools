import { hasApiKey } from "../lib/provider";
import { BODY, LINK_BTN, el } from "./ui";

/**
 * The one sentence a first-time reader needs, shown until a provider key exists. Security and
 * Application work without one, so the banner says which panels are waiting rather than gating
 * the whole panel behind setup. It goes away on its own the moment a key is saved.
 */
export function mountSetupBanner(container: HTMLElement): void {
  const banner = el("div", "flex flex-col gap-1.5 px-4 py-3 border-b border-neutral-800 bg-neutral-800/40");
  banner.setAttribute("role", "status");
  banner.hidden = true;

  banner.append(
    el(
      "p",
      BODY,
      "Human Tools reads the page in front of you. Security and Application work right away; " +
        "Accessibility, Console and Inspector need an API key from OpenAI or OpenRouter.",
    ),
  );
  const setup = el("button", LINK_BTN, "Add an API key →");
  setup.addEventListener("click", () => chrome.runtime.openOptionsPage());
  banner.appendChild(setup);
  container.appendChild(banner);

  async function refresh(): Promise<void> {
    banner.hidden = await hasApiKey();
  }
  void refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("openaiApiKey" in changes || "openrouterApiKey" in changes || "provider" in changes) void refresh();
  });
}
