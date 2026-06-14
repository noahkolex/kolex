// Spin up a throwaway Postgres in Docker, run the normalized-backend tests
// (schema/diff/hydrate/migration + a full-app e2e) against it, then tear it
// down. Skips cleanly when Docker isn't available.
import { spawnSync } from "node:child_process";

const CONTAINER = "kolex-pg-ci";
const PORT = 55433;
const URL = `postgresql://postgres:test@localhost:${PORT}/postgres`;

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const has = (c) => sh(c, ["--version"]).status === 0;

if (!has("docker")) {
  console.log("test:pg — Docker not available, skipping Postgres integration tests.");
  process.exit(0);
}

function up() {
  sh("docker", ["rm", "-f", CONTAINER]);
  const run = sh("docker", ["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=test", "-p", `${PORT}:5432`, "postgres:16-alpine"]);
  if (run.status !== 0) {
    console.log("test:pg — couldn't start Postgres container, skipping.\n" + (run.stderr || ""));
    process.exit(0);
  }
  // Wait for readiness.
  for (let i = 0; i < 40; i++) {
    if (sh("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"]).status === 0) return true;
    sh("sleep", ["0.5"]);
  }
  console.log("test:pg — Postgres never became ready, skipping.");
  down();
  process.exit(0);
}
function down() { sh("docker", ["rm", "-f", CONTAINER]); }

let failed = false;
try {
  up();
  const env = { ...process.env, KOLEX_TEST_DATABASE_URL: URL };
  console.log("\n== normalized backend (schema / diff / hydrate / migration) ==");
  let r = sh("node", ["--test", "test/postgres.test.mjs"], { stdio: "inherit", env });
  failed ||= r.status !== 0;
  console.log("\n== full app on Postgres (money flow + restart) ==");
  r = sh("node", ["test/postgres-e2e.mjs"], { stdio: "inherit", env });
  failed ||= r.status !== 0;
} finally {
  down();
}
process.exit(failed ? 1 : 0);
