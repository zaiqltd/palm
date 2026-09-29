import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { turnFiles, mentionedPaths } from "../server/agents/turn-files.mjs";
import { FsPolicy } from "../server/files/fs-api.mjs";

// "if I ask it to create a PDF, I can't retrieve it in
// chat like the Assistant does". The files a turn made or named become cards.
test("a turn's files: what it made or named, documents first, never code", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "palm-turn-files-"));
  const cwd = path.join(home, "project");
  await mkdir(path.join(cwd, "out"), { recursive: true });
  await mkdir(path.join(cwd, "node_modules"), { recursive: true });
  const old = new Date(Date.now() - 3600_000);
  const since = Date.now();
  const write = async (rel, body = "x", when = null) => {
    const file = path.join(cwd, rel);
    await writeFile(file, body);
    if (when) await utimes(file, when, when);
    return file;
  };
  const report = await write("out/report.pdf", "%PDF-1.4\n");
  const chart = await write("chart.png");
  const notes = await write("notes.md");
  const code = await write("app.ts");
  await write("node_modules/dep.pdf");
  const invoice = await write("invoice.pdf", "%PDF", old);
  const oldReadme = await write("README.md", "#", old);
  const page = await write("index.html");
  const oldPage = await write("about.html", "<p>", old);
  const policy = new FsPolicy({ stateDir: path.join(home, "state") });

  const files = await turnFiles({
    texts: ["Done. The report is `out/report.pdf`; I also looked at invoice.pdf and README.md, and served index.html and about.html."],
    tools: [{ name: "Write", detail: code }, { name: "files", detail: `add ${notes}` }],
    cwd, since, home, policy,
  });
  const names = files.map((f) => path.basename(f.file));
  assert.deepEqual(names.slice(0, 3), ["report.pdf", "invoice.pdf", "index.html"], "named files first, in the agent's order");
  assert.ok(names.includes("notes.md"), "a text file the turn created");
  assert.ok(names.includes("chart.png"), "a picture made beside it while it worked");
  assert.ok(!names.includes("app.ts"), "code is never a card");
  assert.ok(!names.includes("dep.pdf"), "dependencies are not looked through");
  assert.ok(!names.includes("README.md"), "an old text file, even named, is not a card");
  assert.ok(!names.includes("about.html"), "nor an old page it only mentions");
  assert.equal(files.length <= 6, true);

  // Paths in the agent's words: absolute, home and markdown links.
  const mentioned = mentionedPaths("See ~/Downloads/a.pdf, [the chart](charts/b.png) and /tmp/c.csv.", { cwd, home });
  assert.deepEqual(mentioned.map((p) => path.relative(home, p)).filter((p) => !p.startsWith("..")), ["Downloads/a.pdf", "project/charts/b.png"]);
  assert.ok(mentioned.includes("/tmp/c.csv"));
});
