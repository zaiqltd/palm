import { randomUUID } from "node:crypto";
import { copyFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";

// Test host only (PALM_SYNTHETIC=1). A deterministic stand-in for Claude Code,
// Codex and the agents reached through ACP so the phone's agent screens can be exercised end to end —
// streaming text, a tool call, an approval and Stop — without a real model,
// a subscription or any change to the Mac. It emits the same event shapes as
// the real adapters.
//
// What it does depends on the message:
//   contains "approve" -> asks to run a command; Allow runs it, Deny declines
//   contains "slow"    -> keeps streaming for about 30 seconds (to test Stop)
//   contains "use the screen" -> looks at the screen and clicks it through
//                        Palm's own screen tools (the same rules a real agent
//                        meets), then keeps working for about 25 seconds
//   a job from Palm's Assistant to export a file as a PDF -> writes the PDF
//                        next to it (inside the test host's throwaway home) and
//                        names it on a RESULT line, as real agents are asked to
//   contains "make a pdf" -> writes palm-report.pdf in the session's folder
//                        (inside the test host's throwaway home) and names it
//   anything else      -> streams a reply that repeats the message, with one tool step
export class ScriptedAdapter {
  constructor({ task, emit, tool = null }) {
    this.task = task;
    this.emit = emit;
    // Palm's screen tools, as a real agent calls them through the MCP server.
    this.tool = tool;
    this.timers = new Set();
    this.approvals = new Map();
    this.active = false;
    this.started = 0;
  }

  static providers() {
    // Demo recordings show no test labels: no version or plan line.
    const common = process.env.PALM_DEMO === "1" ? { available: true, signedIn: true } : { available: true, version: "test", signedIn: true, plan: "Test host" };
    return [
      { id: "claude", name: "Claude Code", ...common },
      process.env.PALM_DEMO === "1"
        ? { id: "codex", name: "Codex", ...common }
        : { id: "codex", name: "Codex", ...common, models: ["default", "scripted-fast"], modelNames: { "scripted-fast": "Scripted fast" }, defaultModel: "scripted-fast" },
      // Stands in for any agent Palm reaches through the Agent Client Protocol.
      { id: "grok", name: "Grok", ...common, modes: ["ask", "workspace", "full", "plan"], acp: true },
    ];
  }

  async send({ text }) {
    if (this.active) throw new Error("The test agent is already working.");
    this.active = true;
    this.started = Date.now();
    this.emit({ type: "turn", status: "started" });
    this.emit({ type: "session", sessionId: `scripted-${this.task.id}`, model: "scripted" });
    const lower = text.toLowerCase();
    if (process.env.PALM_DEMO === "1") return this.demoTurn(lower);
    if (lower.includes("approve")) return this.approvalTurn();
    if (lower.includes("use the screen")) return this.screenTurn();
    if (lower.includes("slow")) return this.stream(`Working slowly so you can stop me. `.repeat(60), 500, () => this.finish("completed"));
    if (text.includes("(Sent by Palm's Assistant")) return this.handoffTurn(text);
    if (lower.includes("make a pdf")) return this.pdfTurn();
    const tool = randomUUID();
    this.later(250, () =>
      this.emit({ type: "tool", itemId: tool, name: "Read", title: "Read README.md", detail: "README.md", status: "running" }),
    );
    this.later(600, () => this.emit({ type: "tool", itemId: tool, status: "completed", output: "# Sample project\nA fixture for Palm's tests." }));
    this.later(700, () =>
      this.stream(`Test agent reply. You said: "${text.slice(0, 200)}". Nothing on your Mac was changed.`, 60, () => this.finish("completed")),
    );
  }

  async screenTurn() {
    const call = async (name, args) => {
      const item = randomUUID();
      this.emit({ type: "tool", itemId: item, name: `mcp__palm__${name}`, title: name === "click" ? "Click on the screen" : "Look at the screen", status: "running" });
      const result = await Promise.resolve(this.tool?.(name, args)).catch((error) => ({ isError: true, content: [{ type: "text", text: error.message }] }));
      const said = result?.content?.find((c) => c.type === "text")?.text || "";
      this.emit({ type: "tool", itemId: item, status: result?.isError ? "failed" : "completed", output: said.slice(0, 300) });
      return result?.isError ? said : null;
    };
    // Like a real agent told "wait a moment": a person using the screen is waited for.
    let refused = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      refused = (await call("screenshot", {})) || (await call("click", { x: 640, y: 400 }));
      if (!refused || !/controlling the Mac screen|changing hands/.test(refused) || !this.active) break;
      await new Promise((resolve) => this.later(3000, resolve));
    }
    if (!this.active) return;
    if (refused) return this.stream(`I could not use the screen: ${refused}`, 40, () => this.finish("completed"));
    // Works on quietly for a while, holding the screen, then finishes.
    this.emit({ type: "assistant", itemId: randomUUID(), text: "I'm working on the Mac screen now." });
    this.later(25000, () => this.finish("completed"));
  }

  async pdfTurn() {
    const home = os.homedir();
    const folder = this.task.cwd || home;
    if (!(folder === home || folder.startsWith(home + "/"))) {
      return this.later(300, () => this.stream("I only write inside the test home.", 40, () => this.finish("completed")));
    }
    const tool = randomUUID();
    this.emit({ type: "tool", itemId: tool, name: "Bash", title: "Run command", detail: "python3 make_report.py", status: "running" });
    await writeFile(`${folder}/palm-report.pdf`, "%PDF-1.4\n% Palm test report\n");
    this.later(300, () => {
      this.emit({ type: "tool", itemId: tool, status: "completed", output: "Wrote palm-report.pdf" });
      this.stream("Made the report: `palm-report.pdf` in this folder.", 40, () => this.finish("completed"));
    });
  }

  async handoffTurn(text) {
    const home = os.homedir();
    const source = /((?:~|\/)[^\n]*?\.(?:docx|md|txt|pages|rtf))/i.exec(text)?.[1];
    const full = source?.startsWith("~/") ? home + source.slice(1) : source;
    if (full && full.startsWith(home + "/") && /\bpdf\b/i.test(text) && (await stat(full).catch(() => null))?.isFile()) {
      const pdf = full.replace(/\.[^./]+$/, ".pdf");
      await writeFile(pdf, "%PDF-1.4\n% Palm test export\n");
      return this.later(300, () => this.stream(`Exported it as a PDF.\nRESULT: ${pdf}`, 40, () => this.finish("completed")));
    }
    this.later(300, () => this.stream("I looked through the Mac and found nothing like that.", 40, () => this.finish("completed")));
  }

  // Demo recordings (PALM_DEMO=1): realistic work at a watchable pace. The
  // dark-mode task asks to run the tests; allowing it finishes the change and
  // switches the demo Mac screen to its "after" picture.
  demoTurn(lower) {
    const step = (at, name, title, detail, output, took = 350) => {
      const item = randomUUID();
      this.later(at, () => this.emit({ type: "tool", itemId: item, name, title, detail, status: "running" }));
      this.later(at + took, () => this.emit({ type: "tool", itemId: item, status: "completed", output }));
    };
    if (lower.includes("dark mode")) {
      step(400, "Read", "Read Settings.tsx", "src/components/Settings.tsx", "export function Settings() {");
      step(1100, "Grep", "Search for theme", "theme", "4 matches in 3 files");
      this.later(1800, () =>
        this.stream("I'll add a Dark mode switch to Settings that follows the system until you choose, and save the choice. ", 55, () => {
          step(200, "Edit", "Edit Settings.tsx", "src/components/Settings.tsx", "+7 lines");
          step(800, "Edit", "Edit theme.ts", "src/theme.ts", "+18 lines");
          this.later(1500, () => {
            this.demoApproval = randomUUID();
            this.approvals.set(this.demoApproval, true);
            this.emit({ type: "approval", approvalId: this.demoApproval, status: "pending", tool: "Bash", title: "Run a command", detail: "npm test", options: ["allow", "allowSession", "deny"] });
          });
        }),
      );
      return;
    }
    if (lower.includes("flaky")) {
      step(500, "Read", "Read checkout.test.ts", "tests/checkout.test.ts", "describe(\"checkout\")");
      step(1400, "Bash", "Run a command", "npm test -- checkout --repeat 20", "3 of 20 runs failed: timeout waiting for the payment mock", 2600);
      this.later(4400, () =>
        this.stream("The test waits on a real timer while the payment mock resolves on the next tick, so it races. I'm switching it to fake timers and running it 50 more times to be sure. ".repeat(12), 220, () => this.finish("completed")),
      );
      return;
    }
    if (lower.includes("logs")) {
      step(400, "Bash", "Run a command", "grep -c ERROR logs/api-2026-09-28.log", "37");
      this.later(1200, () =>
        this.stream("37 errors yesterday, 31 of them one cause: the invoice PDF job timed out between 02:00 and 02:40 while the backup ran. The other 6 were expired sessions. No customer requests failed.", 45, () => this.finish("completed")),
      );
      return;
    }
    step(400, "Read", "Read README.md", "README.md", "# acme-web");
    this.later(1000, () => this.stream("Done. I read the project and made no changes.", 50, () => this.finish("completed")));
  }

  approvalTurn() {
    const approvalId = randomUUID();
    this.approvals.set(approvalId, true);
    this.later(300, () =>
      this.emit({
        type: "approval",
        approvalId,
        status: "pending",
        tool: "Bash",
        title: "Run a command",
        detail: "echo palm-test",
        options: ["allow", "allowSession", "deny"],
      }),
    );
  }

  answer(approvalId, decision) {
    if (!this.approvals.delete(approvalId)) throw new Error("That request is no longer waiting.");
    this.emit({ type: "approval", approvalId, status: decision === "deny" ? "denied" : "allowed" });
    if (approvalId === this.demoApproval && decision !== "deny") return this.demoTestsPass();
    if (decision === "deny") {
      this.stream("Understood. I did not run it.", 40, () => this.finish("completed"));
      return;
    }
    const tool = randomUUID();
    this.emit({ type: "tool", itemId: tool, name: "Bash", title: "Run a command", detail: "echo palm-test", status: "running" });
    this.later(400, () => {
      this.emit({ type: "tool", itemId: tool, status: "completed", output: "palm-test" });
      this.stream("The command printed palm-test.", 40, () => this.finish("completed"));
    });
  }

  demoTestsPass() {
    const tool = randomUUID();
    this.emit({ type: "tool", itemId: tool, name: "Bash", title: "Run a command", detail: "npm test", status: "running" });
    this.later(1800, async () => {
      this.emit({ type: "tool", itemId: tool, status: "completed", output: "Test Files  6 passed (6)\n     Tests  42 passed (42)" });
      const screens = process.env.PALM_DEMO_SCREENS;
      const current = process.env.PALM_SYNTHETIC_SCREEN;
      if (screens && current) await copyFile(`${screens}/after.png`, current).catch(() => {});
      this.stream("Done. Settings has a Dark mode switch, it follows your system until you choose, and all 42 tests pass.", 50, () => this.finish("completed"));
    });
  }

  stream(text, perWord, done) {
    const item = randomUUID();
    const words = text.split(/(?<= )/);
    let index = 0;
    const next = () => {
      if (!this.active) return;
      if (index >= words.length) {
        this.emit({ type: "assistant", itemId: item, text });
        done();
        return;
      }
      this.emit({ type: "assistant.delta", itemId: item, text: words[index++] });
      this.later(perWord, next);
    };
    next();
  }

  finish(status) {
    if (!this.active) return;
    this.active = false;
    for (const approvalId of this.approvals.keys()) this.emit({ type: "approval", approvalId, status: "expired" });
    this.approvals.clear();
    this.emit({ type: "turn", status, durationMs: Date.now() - this.started });
  }

  later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  async interrupt() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.finish("interrupted");
  }

  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.active = false;
  }
}
