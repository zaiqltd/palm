import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loginShell, run, userEnvironment } from "../platform/env.mjs";

const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r(?!\n)/g;
const urlPattern = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.local)(?::(\d{2,5}))/gi;
const skip = new Set(["node_modules", ".git", "dist", "build", ".next", ".local", "DerivedData", "Pods", ".venv", "venv", "__pycache__", "data"]);

// Development servers run on the Mac as ordinary child processes of Palm, in
// their own process group, with the user's login-shell environment. Palm records
// output, discovers the listening port from the process group itself, and
// hands the port to the preview gateway. Stopping signals the whole group.
export class DevServers {
  constructor({ roots, ownPorts = [], onChange = () => {} }) {
    this.roots = roots;
    this.ownPorts = new Set(ownPorts);
    this.servers = new Map();
    this.onChange = onChange;
    this.projectCache = null;
  }

  async projects({ refresh = false } = {}) {
    if (this.projectCache && !refresh && Date.now() - this.projectCache.at < 60000)
      return this.projectCache.items;
    const found = new Map();
    const visit = async (dir, depth) => {
      if (found.size >= 400) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const names = new Set(entries.map((e) => e.name));
      const markers = [];
      if (names.has("package.json")) markers.push("node");
      if (names.has(".git")) markers.push("git");
      if ([...names].some((n) => n.endsWith(".xcodeproj") || n === "project.yml")) markers.push("xcode");
      if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("manage.py")) markers.push("python");
      if (names.has("index.html") && !names.has("package.json")) markers.push("static");
      if (names.has("AGENTS.md") || names.has("CLAUDE.md")) markers.push("agents");
      if (markers.length && depth > 0) {
        const project = { name: path.basename(dir), path: dir, markers, scripts: [] };
        if (names.has("package.json")) {
          try {
            const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
            project.scripts = Object.keys(pkg.scripts || {}).slice(0, 40);
            if (typeof pkg.name === "string") project.packageName = pkg.name.slice(0, 80);
          } catch {}
        }
        found.set(dir, project);
      }
      if (depth >= 3) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || skip.has(entry.name)) continue;
        // Descend into grouping folders; a project folder with package.json
        // still gets one more level for monorepo packages and site markets.
        await visit(path.join(dir, entry.name), depth + 1);
      }
    };
    for (const root of this.roots) {
      const info = await stat(root).catch(() => null);
      if (info?.isDirectory()) await visit(root, 0);
    }
    const items = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.projectCache = { at: Date.now(), items };
    return items;
  }

  list() {
    return [...this.servers.values()].map((s) => this.summary(s));
  }

  summary(s) {
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      command: s.command,
      status: s.status,
      pid: s.child?.pid ?? null,
      port: s.port,
      urls: [...s.urls],
      started: s.started,
      exitCode: s.exitCode,
      lines: s.lineCount,
    };
  }

  async start({ cwd, script, command, name } = {}) {
    const folder = path.resolve(cwd || "");
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Choose the project folder on your Mac.");
    let line;
    if (typeof script === "string" && script) {
      if (!/^[\w:.@/-]{1,80}$/.test(script)) throw new Error("That package script name is not supported.");
      const pkg = JSON.parse(await readFile(path.join(folder, "package.json"), "utf8").catch(() => "{}"));
      if (!pkg.scripts?.[script]) throw new Error(`package.json has no "${script}" script.`);
      line = `npm run ${script}`;
    } else if (typeof command === "string" && command.trim() && command.length <= 2000) {
      line = command.trim();
    } else throw new Error("Choose a script or enter a command.");
    for (const existing of this.servers.values())
      if (existing.cwd === folder && existing.command === line && existing.status === "running")
        return this.summary(existing);
    const env = { ...(await userEnvironment()) };
    env.BROWSER = "none"; // Do not open a Mac browser window for the phone's preview.
    env.FORCE_COLOR = "1";
    env.PALM_DEV = "1";
    delete env.PALM_AGENT_TOKEN;
    const id = randomBytes(5).toString("hex");
    const child = spawn(loginShell(), ["-l", "-i", "-c", script ? `exec ${line}` : line], {
      cwd: folder,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const server = {
      id,
      name: name || `${path.basename(folder)} · ${script || line.split(/\s+/)[0]}`,
      cwd: folder,
      command: line,
      script: script || null,
      status: "running",
      child,
      port: null,
      urls: new Set(),
      started: new Date().toISOString(),
      exitCode: null,
      lines: [],
      lineCount: 0,
      partial: "",
      subscribers: new Set(),
    };
    const consume = (chunk) => this.output(server, chunk.toString("utf8"));
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      this.output(server, `Palm could not start this command: ${error.message}\n`);
      this.finished(server, 127);
    });
    child.on("exit", (code, signal) => this.finished(server, code ?? (signal ? 128 : 1)));
    this.servers.set(id, server);
    this.discoverPort(server);
    this.onChange();
    return this.summary(server);
  }

  output(server, text) {
    const combined = server.partial + text.replace(ansi, "");
    const parts = combined.split("\n");
    server.partial = parts.pop() ?? "";
    if (server.partial.length > 4000) {
      parts.push(server.partial);
      server.partial = "";
    }
    const added = [];
    for (const part of parts) {
      const clean = part.replace(/\s+$/, "");
      server.lineCount++;
      const entry = { n: server.lineCount, t: Date.now(), text: clean.slice(0, 2000) };
      server.lines.push(entry);
      added.push(entry);
      for (const match of clean.matchAll(urlPattern)) {
        const port = Number(match[1]);
        if (port && !this.ownPorts.has(port)) {
          server.urls.add(match[0].replace("0.0.0.0", "localhost").replace("[::1]", "localhost"));
          if (!server.port) {
            server.port = port;
            this.onChange();
          }
        }
      }
    }
    if (server.lines.length > 3000) server.lines.splice(0, server.lines.length - 3000);
    if (added.length) for (const listener of server.subscribers) listener(added);
  }

  finished(server, code) {
    if (server.status !== "running") return;
    if (server.partial) this.output(server, "\n");
    server.status = code === 0 ? "exited" : server.stopping ? "stopped" : "failed";
    server.exitCode = code;
    this.onChange();
  }

  async discoverPort(server) {
    // Output parsing is quick but not guaranteed (some tools print nothing);
    // the process group's own listening sockets are the ground truth.
    for (let attempt = 0; attempt < 90 && server.status === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt < 20 ? 500 : 2000));
      if (server.status !== "running") return;
      const ports = await listeningPortsForGroup(server.child.pid);
      const usable = ports.filter((p) => !this.ownPorts.has(p));
      if (usable.length) {
        const preferred = server.port && usable.includes(server.port) ? server.port : usable[0];
        if (preferred !== server.port) {
          server.port = preferred;
          this.onChange();
        }
        return;
      }
    }
  }

  logs(id, after = 0) {
    const server = this.require(id);
    return { id, lines: server.lines.filter((l) => l.n > after).slice(-1000), last: server.lineCount };
  }

  subscribe(id, listener) {
    const server = this.require(id);
    server.subscribers.add(listener);
    return () => server.subscribers.delete(listener);
  }

  async stop(id) {
    const server = this.require(id);
    if (server.status !== "running") return this.summary(server);
    server.stopping = true;
    const pid = server.child.pid;
    try {
      process.kill(-pid, "SIGINT");
    } catch {}
    const ended = await waitFor(() => server.status !== "running", 4000);
    if (!ended) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      if (!(await waitFor(() => server.status !== "running", 3000))) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        await waitFor(() => server.status !== "running", 2000);
      }
    }
    return this.summary(server);
  }

  async restart(id) {
    const server = this.require(id);
    await this.stop(id);
    this.servers.delete(id);
    const next = await this.start({ cwd: server.cwd, script: server.script, command: server.script ? undefined : server.command, name: server.name });
    this.onChange();
    return next;
  }

  remove(id) {
    const server = this.require(id);
    if (server.status === "running") throw new Error("Stop the server before removing it.");
    this.servers.delete(id);
    this.onChange();
  }

  async stopAll() {
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  require(id) {
    const server = this.servers.get(id);
    if (!server) throw new Error("That dev server is no longer listed.");
    return server;
  }

  // Web servers already running on this Mac (started in a terminal, by an
  // agent or by an editor), named by what they are: the page title, the
  // project folder and the framework. System services are left out.
  async running() {
    const raw = await this.listening();
    const results = await Promise.all(
      raw.map(async (entry) => {
        const key = `${entry.pid}:${entry.port}`;
        const cached = this.nameCache?.get(key);
        if (cached && Date.now() - cached.at < 30000) return { ...entry, ...cached.value };
        const value = await describeServer(entry);
        this.nameCache = this.nameCache || new Map();
        this.nameCache.set(key, { at: Date.now(), value });
        return { ...entry, ...value };
      }),
    );
    // One entry per page: tools such as wrangler also open inspector and
    // internal ports that serve the same app or no page at all.
    const seen = new Set();
    return results
      .filter((r) => r.web && !systemProcess(r.process) && !(r.port >= 9229 && r.port <= 9239))
      .sort((a, b) => Number(!!b.title) - Number(!!a.title) || a.port - b.port)
      .filter((r) => {
        const key = `${r.cwd}|${r.title || r.framework || r.process}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.port - b.port);
  }

  // Every TCP listener owned by this user on this Mac, for servers started
  // elsewhere (a terminal, an agent, Xcode). Palm's own ports are excluded.
  async listening() {
    const result = await run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-u", String(process.getuid()), "-F", "pcn"], { timeout: 6000 });
    const out = [];
    let pid = null;
    let name = "";
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("c")) name = line.slice(1);
      else if (line.startsWith("n")) {
        const match = /:(\d+)$/.exec(line);
        const host = line.slice(1, line.lastIndexOf(":"));
        if (!match) continue;
        const port = Number(match[1]);
        if (this.ownPorts.has(port) || port < 1024) continue;
        if (!/^(\*|127\.0\.0\.1|\[::1\]|localhost|\[::\]|0\.0\.0\.0)$/.test(host)) continue;
        if (out.some((o) => o.port === port)) continue;
        out.push({ port, pid, process: name, host });
      }
    }
    const managed = new Map([...this.servers.values()].filter((s) => s.port).map((s) => [s.port, s.id]));
    return out
      .map((o) => ({ ...o, devId: managed.get(o.port) || null }))
      .sort((a, b) => a.port - b.port);
  }
}

const systemNames = /^(ControlCenter|rapportd|sharingd|Discord|Spotify|Slack|figma_agent|Dropbox|OneDrive|Adobe|Creative Cloud|WhatsApp|Microsoft|Teams|zoom|Zoom|Google Chrome|Chrome|Safari|com\.apple|launchd|mDNSResponder|Tailscale|ExpressVPN|ChatGPT|Claude|Aside|Code Helper|Electron|Raycast|1Password|Setapp|Figma|Notion|Arc|Brave|Edge|Microsoft Edge|Yandex|RustDesk|WeChat|Telegram|Palm)/i;
function systemProcess(name = "") {
  return systemNames.test(name.replace(/\\x20/g, " "));
}

const frameworks = [
  [/\bnext(-server)?\b|next dev/, "Next.js"],
  [/\bastro\b/, "Astro"],
  [/\bvite\b/, "Vite"],
  [/wrangler|workerd/, "Cloudflare Workers"],
  [/\bremix\b/, "Remix"],
  [/\bnuxt\b/, "Nuxt"],
  [/svelte-kit|sveltekit/, "SvelteKit"],
  [/webpack/, "webpack"],
  [/storybook/, "Storybook"],
  [/http\.server|SimpleHTTPServer/, "Python http.server"],
  [/uvicorn|fastapi/, "FastAPI"],
  [/flask/, "Flask"],
  [/manage\.py runserver|django/, "Django"],
  [/\brails\b|puma/, "Rails"],
  [/\bhugo\b/, "Hugo"],
  [/jekyll/, "Jekyll"],
  [/\bbun\b/, "Bun"],
  [/\bdeno\b/, "Deno"],
];

async function describeServer(entry) {
  const home = os.homedir();
  const [cwdResult, commandResult] = await Promise.all([
    entry.pid ? run("/usr/sbin/lsof", ["-a", "-p", String(entry.pid), "-d", "cwd", "-Fn"], { timeout: 3000 }) : null,
    entry.pid ? run("/bin/ps", ["-o", "command=", "-p", String(entry.pid)], { timeout: 3000 }) : null,
  ]);
  const cwd = /^n(.+)$/m.exec(cwdResult?.stdout || "")?.[1] || null;
  const command = (commandResult?.stdout || "").trim();
  const framework = frameworks.find(([pattern]) => pattern.test(command))?.[1] || null;
  const project = cwd && cwd !== "/" && cwd !== home ? path.basename(cwd) : null;
  const where = cwd?.startsWith(home + "/") ? "~/" + path.relative(home, cwd) : cwd;
  let title = null;
  let web = false;
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/`, {
      signal: AbortSignal.timeout(900),
      redirect: "manual",
      headers: { Accept: "text/html,*/*" },
    });
    const type = response.headers.get("content-type") || "";
    web = type.includes("html") || (!!framework && response.status < 400) || (response.status >= 300 && response.status < 400);
    if (type.includes("html")) {
      const text = (await response.text()).slice(0, 65536);
      const match = /<title[^>]*>([^<]{1,160})<\/title>/i.exec(text);
      if (match) title = match[1].replace(/\s+/g, " ").trim().replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    } else response.body?.cancel().catch(() => {});
  } catch {
    web = false;
  }
  const name = title || project || framework || entry.process;
  return { name, title, project, cwd: where, framework, web };
}

async function listeningPortsForGroup(pgid) {
  if (!pgid) return [];
  const result = await run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-g", String(pgid), "-F", "n"], { timeout: 5000 });
  const ports = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^n.*:(\d+)$/.exec(line);
    if (match && !ports.includes(Number(match[1]))) ports.push(Number(match[1]));
  }
  return ports;
}

function waitFor(predicate, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - start > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// The usual places developers keep code. Missing folders are skipped.
export const defaultProjectRoots = () => {
  const home = os.homedir();
  return [
    path.join(home, "work"),
    ...["Developer", "Projects", "Code", "src", "Sites", "Documents/GitHub"].map((d) => path.join(home, d)),
  ];
};
