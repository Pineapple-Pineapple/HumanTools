import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Human Tools",
  description: "DevTools for what a page means, not how it's built.",
  version: "0.1.0",
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
  options_page: "src/options/index.html",
  // activeTab alone only grants page access for the exact tab active at the moment
  // the toolbar icon is clicked; since the side panel stays open across tab switches
  // and Analyze/Rewrite/Restore happen well after that click, declared host_permissions
  // are needed for chrome.scripting.executeScript to reliably reach the active tab later.
  permissions: ["scripting", "storage", "sidePanel"],
  host_permissions: ["http://*/*", "https://*/*"],
});
