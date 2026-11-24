// Pre-flight check, run automatically by npm after install and before start/dev:
// verifies the Node.js version and the sample data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  console.error(`Insight Hub needs Node.js 20 or newer. You have ${process.versions.node}.`);
  process.exit(1);
}

if (!fs.existsSync(path.join(root, "samples", "transcripts"))) {
  console.warn("Heads-up: samples/transcripts is missing, so the sample interviews won't be available.");
}

console.log(`✓ Insight Hub environment OK (Node ${process.versions.node})`);
