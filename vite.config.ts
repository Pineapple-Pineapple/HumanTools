import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest }), tailwindcss()],
  build: {
    // The side panel bundles the full Public Suffix List (~230 KB) for Security's registrable-domain
    // check. It loads from disk, not the network, so the default 500 KB warning is noise here.
    chunkSizeWarningLimit: 800,
  },
});
