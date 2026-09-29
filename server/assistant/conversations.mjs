import path from "node:path";
import { readJSON, writePrivateJSON } from "../platform/store.mjs";

// What the Assistant remembers of a conversation, on the Mac it happened on:
// the last turns (what was asked, what came back) and the things they were
// about (files, a folder or project, an agent session, a preview), so "send
// me that file", "use that project" and "tell it to..." mean the actual
// earlier results. Agents' results for a hand-off arrive here as follow-ups.
// At most 30 turns per conversation; each conversation is one private file.

const maxTurns = 30;

export class Conversations {
  constructor({ stateDir }) {
    this.dir = path.join(stateDir, "assistant");
    this.cache = new Map();
  }

  static valid(id) {
    return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);
  }

  async get(id) {
    if (!Conversations.valid(id)) return null;
    if (!this.cache.has(id)) {
      const saved = await readJSON(path.join(this.dir, `${id}.json`), null);
      this.cache.set(id, {
        id, turns: Array.isArray(saved?.turns) ? saved.turns : [], proposals: saved?.proposals ?? {}, chosen: saved?.chosen ?? null,
      });
    }
    return this.cache.get(id);
  }

  async save(conversation) {
    // Proposals go with their turn when it ages out, and there are never many.
    const dropped = new Set(conversation.turns.slice(0, Math.max(0, conversation.turns.length - maxTurns)).map((t) => t.id));
    conversation.turns = conversation.turns.slice(-maxTurns);
    for (const [key, proposal] of Object.entries(conversation.proposals)) if (dropped.has(proposal.turn)) delete conversation.proposals[key];
    const keys = Object.keys(conversation.proposals);
    for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete conversation.proposals[key];
    await writePrivateJSON(path.join(this.dir, `${conversation.id}.json`), {
      turns: conversation.turns, proposals: conversation.proposals, chosen: conversation.chosen,
    });
  }

  async addTurn(id, turn) {
    const conversation = await this.get(id);
    if (!conversation) return;
    const index = conversation.turns.findIndex((t) => t.id === turn.id);
    const entry = { at: new Date().toISOString(), followups: [], ...turn };
    if (index >= 0) conversation.turns[index] = { ...conversation.turns[index], ...entry };
    else conversation.turns.push(entry);
    await this.save(conversation);
  }

  async followup(id, turnId, reply) {
    const conversation = await this.get(id);
    const turn = conversation?.turns.find((t) => t.id === turnId);
    if (!turn) return null;
    turn.followups = [...(turn.followups || []), { at: new Date().toISOString(), ...reply }];
    await this.save(conversation);
    return turn;
  }

  /**
   * The file the person saved, opened or showed from a card here: "that file"
   * from now on, until newer files come up (E2E, 23 September: the one saved
   * was not the one "send me that file" sent). Only a file this conversation
   * listed counts.
   */
  async choose(id, filePath) {
    const conversation = await this.get(id);
    if (!conversation || typeof filePath !== "string") return false;
    if (!fileCards(conversation).some((c) => c.path === filePath)) return false;
    conversation.chosen = { path: filePath, at: new Date().toISOString() };
    await this.save(conversation);
    return true;
  }

  async propose(id, proposal) {
    const conversation = await this.get(id);
    if (!conversation) return;
    conversation.proposals[proposal.id] = proposal;
    await this.save(conversation);
  }

  async proposal(id, proposalId) {
    return (await this.get(id))?.proposals?.[proposalId] ?? null;
  }

  /**
   * The things recent turns were about, newest first: files, the folder or
   * project, the agent session and the preview.
   */
  async context(id) {
    const conversation = await this.get(id);
    const out = { turns: [], files: [], folder: null, task: null, preview: null };
    if (!conversation) return out;
    out.turns = conversation.turns.slice(-6);
    let filesAt = null;
    for (const turn of [...conversation.turns].reverse()) {
      const cards = [...(turn.followups || []).flatMap((f) => f.cards || []).reverse(), ...(turn.cards || [])];
      for (const card of cards) {
        if (card.type === "file" && !out.files.length) {
          out.files = cards.filter((c) => c.type === "file");
          filesAt = [...(turn.followups || [])].reverse().find((f) => (f.cards || []).some((c) => c.type === "file"))?.at || turn.at || null;
        }
        if (card.type === "task" && !out.task) out.task = card;
        if (card.type === "preview" && !out.preview) out.preview = card;
        if (!out.folder) {
          if (card.type === "folder" && card.path) out.folder = { path: card.path, label: card.name || path.basename(card.path) };
          else if ((card.type === "task" || card.type === "preview") && card.cwd) out.folder = { path: card.cwd, label: path.basename(card.cwd) };
        }
      }
      if (out.files.length && out.task && out.folder && out.preview) break;
    }
    // The file acted on since the newest results is the one meant.
    const chosen = conversation.chosen;
    if (chosen && (!filesAt || chosen.at >= filesAt)) {
      const card = fileCards(conversation).find((c) => c.path === chosen.path);
      if (card) out.files = [card, ...out.files.filter((c) => c.path !== chosen.path)];
    }
    return out;
  }
}

function fileCards(conversation) {
  return conversation.turns.flatMap((t) => [...(t.cards || []), ...(t.followups || []).flatMap((f) => f.cards || [])]).filter((c) => c.type === "file");
}
