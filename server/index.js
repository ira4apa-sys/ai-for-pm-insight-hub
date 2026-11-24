import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { askKb } from "./lib/ask.js";
import { testEngine } from "./lib/claude.js";
import { loadConfig, publicConfig, saveConfig } from "./lib/config.js";
import { listDir, listTranscripts, makeDir, readJson, writeJson } from "./lib/files.js";
import { PUBLIC_DIR, ROOT } from "./lib/paths.js";
import { cancelPipeline, normalizeTaxonomy, outPaths, pipelineStatus, startPipeline } from "./lib/pipeline.js";
import { loadState, patchSolution, withState } from "./lib/state.js";

// Insight Hub's local server. It only listens on this computer (127.0.0.1), and it only answers
// requests addressed to localhost, so other machines and other websites can't use it.
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 4317;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const DEMO_DIR = path.join(ROOT, "samples", "demo-output");

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
const fail = (res, status, message) => send(res, status, { error: message });

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Body must be JSON."), { status: 400 });
  }
}

function paths() {
  const cfg = loadConfig();
  if (!cfg.outputDir) throw Object.assign(new Error("Pick an output folder in Settings first."), { status: 409 });
  return outPaths(cfg.outputDir);
}

function loadKb() {
  const P = paths();
  const kb = readJson(P.kb);
  return kb ? withState(kb, loadState(P)) : null;
}

function serveStatic(req, res, pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, "index.html")), TYPES[".html"]);
  }
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, "Not found");
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
}

const routes = {
  "GET /api/config": () => publicConfig(),
  "POST /api/config": async (req) => publicConfig(saveConfig(await readBody(req))),
  "GET /api/fs/list": (req, url) => listDir(url.searchParams.get("path") || ""),
  "POST /api/fs/mkdir": async (req) => {
    const { path: p } = await readBody(req);
    if (!p) throw Object.assign(new Error("Give a folder path."), { status: 400 });
    return { path: makeDir(p) };
  },
  "POST /api/engine/test": async () => ({ message: await testEngine() }),
  "GET /api/transcripts": () => {
    const cfg = loadConfig();
    const files = listTranscripts(cfg.transcriptsDir);
    const manifest = cfg.outputDir ? readJson(outPaths(cfg.outputDir).manifest, { files: {} }) : { files: {} };
    return files.map(({ file, ...f }) => {
      const m = manifest.files[f.name];
      return { ...f, status: f.tooBig ? "too_big" : !m ? "new" : m.hash === f.hash ? "processed" : "changed", sourceId: m?.sourceId || null };
    });
  },
  "GET /api/taxonomy": () => readJson(paths().taxonomy),
  "PUT /api/taxonomy": async (req) => {
    const P = paths();
    const tax = normalizeTaxonomy(await readBody(req), loadConfig().product);
    writeJson(P.taxonomy, tax);
    return tax;
  },
  "POST /api/pipeline/run": async (req) => {
    const { mode = "all" } = await readBody(req);
    startPipeline(mode);
    return pipelineStatus();
  },
  "POST /api/pipeline/cancel": () => (cancelPipeline(), pipelineStatus()),
  "GET /api/pipeline/status": () => pipelineStatus(),
  "GET /api/kb": () => loadKb(),
  "POST /api/solutions": async (req) => {
    const { id, patch, what } = await readBody(req);
    return patchSolution(paths(), String(id || ""), patch, what);
  },
  "POST /api/ask": async (req) => {
    const { messages } = await readBody(req);
    const kb = loadKb();
    if (!kb) throw Object.assign(new Error("Build the knowledge base first (Process tab)."), { status: 409 });
    const ctl = new AbortController();
    req.on("close", () => !req.complete || ctl.abort());
    return askKb(kb, Array.isArray(messages) ? messages : [], ctl.signal);
  },
  "GET /api/demo": () => ({ available: fs.existsSync(path.join(DEMO_DIR, "kb.json")) }),
  "POST /api/demo/load": () => {
    // Copy the pre-built results for the sample interviews into your output folder.
    const P = paths();
    if (!fs.existsSync(path.join(DEMO_DIR, "kb.json"))) throw Object.assign(new Error("No demo results in this copy of the repo."), { status: 404 });
    if (fs.existsSync(P.kb)) throw Object.assign(new Error("Your output folder already has results. Pick an empty folder to load the demo."), { status: 409 });
    fs.cpSync(DEMO_DIR, path.dirname(P.kb), { recursive: true });
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  try {
    // Only answer requests made to this app on this computer (blocks DNS-rebinding tricks).
    if (!ALLOWED_HOSTS.has(req.headers.host || "")) return fail(res, 403, "Forbidden host");
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/api/")) return req.method === "GET" ? serveStatic(req, res, url.pathname) : fail(res, 405, "Method not allowed");
    // Changes must come from this app's own page, as JSON: other websites can't trigger them.
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return fail(res, 403, "Forbidden origin");
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return fail(res, 415, "Send JSON");
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return fail(res, 404, "Unknown API route");
    const out = await handler(req, url);
    send(res, 200, out ?? null);
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || (e.name === "ClaudeError" ? 502 : 500), e.message || "Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Insight Hub is running → http://localhost:${PORT}\n  (Ctrl+C to stop)\n`);
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is busy. Stop the other app or run: PORT=4318 npm start` : e.message);
  process.exit(1);
});
