import path from "node:path";
import { readJSON, writePrivateJSON } from "../platform/store.mjs";

// The optional OpenRouter route (the brief, priority 4): real agent work paid
// per use through the user's own OpenRouter key, run by a maintained coding
// agent (OpenCode, reached through the Agent Client Protocol) rather than a
// runtime Palm writes itself. It is a separate agent in the list, labelled as
// paid per use, and only runs when chosen: nothing ever falls back to it.
//
// The key stays on the Mac (Palm's voice key, secrets/openrouter.json) and is
// handed only to that agent's process. Spending is enforced here: a turn does
// not start once the day's limit is reached, and a running session is stopped
// when the day's or the session's limit is crossed, from the key's own usage
// record at OpenRouter. That record covers everything the key is used for,
// so the figures are the key's, not Palm's alone.

const api = "https://openrouter.ai/api/v1";
const defaults = { enabled: false, model: "openai/gpt-6-luna", dailyLimitUsd: 5, taskLimitUsd: 2 };
// The test host: two stand-in models and fixed usage, never the network.
const syntheticModels = [
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna", inputPerMillion: 0.4, outputPerMillion: 1.6 },
  { id: "test/sample-coder", name: "Sample Coder (test)", inputPerMillion: 1, outputPerMillion: 2 },
];

export class ApiRoute {
  constructor({ stateDir, voice, fetch = globalThis.fetch, pollMs = 15000, synthetic = false }) {
    this.file = path.join(stateDir, "api-route.json");
    this.synthetic = synthetic;
    this.voice = voice;
    this.fetch = fetch;
    this.pollMs = pollMs;
    this.cached = null;
    this.catalogue = null;
    this.guards = new Map();
  }

  async settings() {
    if (!this.cached) this.cached = { ...defaults, ...((await readJSON(this.file, null)) || {}) };
    return this.cached;
  }

  async update(patch = {}) {
    const next = { ...(await this.settings()) };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (patch.model !== undefined) {
      if (typeof patch.model !== "string" || !/^[\w.\-]+\/[\w.:\-]+$/.test(patch.model)) throw new Error("Choose a model from the list.");
      next.model = patch.model;
    }
    for (const field of ["dailyLimitUsd", "taskLimitUsd"]) {
      if (patch[field] === undefined) continue;
      const value = Number(patch[field]);
      if (!Number.isFinite(value) || value < 0.1 || value > 1000) throw new Error("Limits are between $0.10 and $1,000.");
      next[field] = Math.round(value * 100) / 100;
    }
    await writePrivateJSON(this.file, next);
    this.cached = next;
    return next;
  }

  /** Models that can call tools (an agent needs them), from OpenRouter's public list. */
  async models() {
    if (this.synthetic) return syntheticModels;
    if (this.catalogue && Date.now() - this.catalogue.at < 3600_000) return this.catalogue.items;
    const r = await this.fetch(`${api}/models`).catch(() => null);
    if (!r?.ok) return this.catalogue?.items ?? [];
    const data = (await r.json().catch(() => null))?.data ?? [];
    const perMillion = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 1e6 * 100) / 100 : null);
    const items = data
      .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
      .map((m) => ({ id: m.id, name: m.name || m.id, inputPerMillion: perMillion(m.pricing?.prompt), outputPerMillion: perMillion(m.pricing?.completion) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.catalogue = { at: Date.now(), items };
    return items;
  }

  async usage() {
    if (this.synthetic) return { today: 0.12, month: 1.84, total: 1.84, limit: null, remaining: null };
    return (await this.voice.status({ usage: true }).catch(() => null))?.usage ?? null;
  }

  async status({ installed }) {
    const settings = await this.settings();
    const key = await this.voice.configured();
    return { ...settings, keySet: key, installed, usage: key ? await this.usage() : null };
  }

  /** Ready to run: a key, switched on, and today's limit not reached. */
  async canStart() {
    const settings = await this.settings();
    if (!settings.enabled) throw new Error("The OpenRouter route is off. Turn it on in More › Preferences.");
    const key = this.synthetic ? "synthetic" : await this.voice.key();
    if (!key) throw new Error("Add your OpenRouter key in More › Preferences › Voice first.");
    const usage = await this.usage();
    if (usage?.today != null && usage.today >= settings.dailyLimitUsd)
      throw new Error(`Today's OpenRouter limit of $${settings.dailyLimitUsd.toFixed(2)} is used ($${usage.today.toFixed(2)} on this key today). Raise it in Preferences or wait until tomorrow.`);
    return { key, settings };
  }

  /** What the route's agent is given: the key and the model, for its process only. */
  async environment() {
    const { key, settings } = await this.canStart();
    return {
      OPENROUTER_API_KEY: key,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: `openrouter/${settings.model}`,
        provider: { openrouter: { options: { apiKey: "{env:OPENROUTER_API_KEY}" } } },
      }),
    };
  }

  /**
   * Watches spending while a session works: stops it once the session's or
   * the day's limit is crossed. Returns the amount spent when the turn ends.
   */
  async guard(taskId, { spentBefore = 0, stop, report }) {
    this.release(taskId);
    const settings = await this.settings();
    const start = (await this.usage())?.today ?? null;
    const check = async () => {
      const today = (await this.usage())?.today;
      if (today == null || start == null) return;
      const spent = spentBefore + Math.max(0, today - start);
      report?.(spent);
      const reason =
        spent >= settings.taskLimitUsd ? `this session's limit of $${settings.taskLimitUsd.toFixed(2)}`
        : today >= settings.dailyLimitUsd ? `today's limit of $${settings.dailyLimitUsd.toFixed(2)}`
        : null;
      if (reason) {
        this.release(taskId);
        await stop(`Stopped: it reached ${reason} ($${spent.toFixed(2)} spent in this session).`);
      }
    };
    const timer = setInterval(() => void check().catch(() => {}), this.pollMs);
    timer.unref?.();
    this.guards.set(taskId, { timer, check, start, spentBefore });
    return this.guards.get(taskId);
  }

  /** The turn ended: one last reading, then stop watching. */
  async finish(taskId) {
    const guard = this.guards.get(taskId);
    if (!guard) return null;
    this.release(taskId);
    const today = (await this.usage())?.today;
    if (today == null || guard.start == null) return guard.spentBefore;
    return guard.spentBefore + Math.max(0, today - guard.start);
  }

  release(taskId) {
    const guard = this.guards.get(taskId);
    if (guard) clearInterval(guard.timer);
    this.guards.delete(taskId);
  }
}
