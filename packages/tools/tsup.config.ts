import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core.ts",
    read: "src/read.ts",
    write: "src/write.ts",
    grep: "src/grep.ts",
    glob: "src/glob.ts",
    bash: "src/bash.ts",
    webfetch: "src/webfetch.ts",
    lsp: "src/lsp.ts",
    skill: "src/skill.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: false,
  treeshake: true,
});
