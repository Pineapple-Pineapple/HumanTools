import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest }), tailwindcss()],
});
