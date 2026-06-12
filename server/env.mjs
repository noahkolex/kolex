// Minimal .env loader — no dependency. Loads KEY=VALUE lines from a .env file
// into process.env (without overriding already-set vars). Supports comments,
// blank lines, quoted values, and `export ` prefixes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(file = process.env.KOLEX_ENV_FILE) {
  const candidates = file
    ? [file]
    : [path.join(DIR, "..", ".env"), path.join(process.cwd(), ".env")];
  for (const p of candidates) {
    let raw;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      // Strip surrounding quotes; honor inline # only when unquoted.
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) {
        val = val.slice(1, -1);
      } else {
        const hash = val.indexOf(" #");
        if (hash >= 0) val = val.slice(0, hash);
        val = val.trim();
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return p; // loaded the first one found
  }
  return null;
}
