import { build } from "esbuild";

// Backend endpoints are injected at build time from env, so the extension can
// be pointed at a local server for testing or a production server for release.
//   KOLEX_API_BASE   default https://api.kolex.ai/v1
//   KOLEX_SITE_BASE  default https://kolex.ai
const API_BASE = process.env.KOLEX_API_BASE || "https://api.kolex.ai/v1";
const SITE_BASE = process.env.KOLEX_SITE_BASE || "https://kolex.ai";
// Demo mode: a self-contained build with baked-in fake ads + earnings and NO
// backend, for screen recordings. Enabled via `npm run build:demo`.
const DEMO = /^(1|true|yes|on)$/i.test(process.env.KOLEX_DEMO || "");

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
    define: {
      __KOLEX_API_BASE__: JSON.stringify(API_BASE),
      __KOLEX_SITE_BASE__: JSON.stringify(SITE_BASE),
      __KOLEX_DEMO__: JSON.stringify(DEMO),
    },
  });
}

console.log(
  `built ${entries.length} bundles → extension/  (api: ${API_BASE}${DEMO ? ", DEMO MODE — fake ads/earnings, no backend" : ""})`,
);
