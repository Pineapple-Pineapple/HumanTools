import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Human Tools",
  description: "DevTools for what a page means, not how it's built.",
  version: "0.1.0",
  // chrome.sidePanel.setPanelBehavior and AbortSignal.any both arrived in 116; on anything older
  // the extension would install and then quietly fail to open.
  minimum_chrome_version: "116",
  icons: {
    16: "public/icon16.png",
    48: "public/icon48.png",
    128: "public/icon128.png",
  },
  action: {
    default_title: "Human Tools",
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  // No content script runs on page load: every panel injects its collector with chrome.scripting
  // when the reader clicks, so the extension needs to reach whichever http(s) tab is in front of
  // them at that moment. activeTab would not do — it only covers the tab that was active when the
  // toolbar icon was clicked, and the side panel outlives that tab across switches and navigations.
  permissions: ["scripting", "storage", "sidePanel"],
  host_permissions: ["http://*/*", "https://*/*"],
});
