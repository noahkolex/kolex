import { build } from "esbuild";

const entries = [
  { in: "src/content/index.ts", out: "extension/content.js" },
  { in: "src/background/index.ts", out: "extension/background.js" },
  { in: "src/popup/index.ts", out: "extension/popup.js" },
];

for (const { in: entry, out } of entries) {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "iife",
    target: "chrome110",
    minify: false,
    sourcemap: false,
    logLevel: "warning",
  });
}

console.log(`built ${entries.length} bundles → extension/`);
