import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: {
    include: ["src/**/*.test.ts"],
  },
  build: {
    outDir: "dist",
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
