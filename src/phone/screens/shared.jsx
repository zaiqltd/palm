// More › Shared (PalmSharedView): links, notes and files the Mac passed to this
// phone, newest first, kept until removed. Tap a link to open it, a note to
// read and copy it, a file to bring it to this phone. The Mac adds them with
// palm-share, an agent's share_to_phone or its clipboard; the phone adds notes.
import React, { useEffect, useState } from "react";
import { AlignLeft, ClipboardPaste, Copy, Ellipsis, ExternalLink, File, FileArchive, FileText, Film, Image as ImageIcon, Inbox, KeyRound, Link, Share, SquarePen, Trash2 } from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { connection } from "../core/connection.js";
import { events } from "../core/events.js";
import { bytes, displayPath, relative } from "../core/format.js";
import { nav } from "../core/navigator.js";
import { createStore, useStore } from "../core/store.js";
import { ContentUnavailable, DoneButton, GlassButton, GlassTextButton, Icon, List, Row, Section, Sheet, Spinner, useDialog, useMenu, useToast } from "../ui/kit.jsx";
import { PushedBar } from "./more.jsx";
import { SavedFileSheet, downloadFile, useHome } from "./files.jsx";

const SEEN = "palm.shared.seen";
const readSeen = () => {
  try {
    return localStorage.getItem(SEEN);
  } catch {
    return null;
  }
};
const writeSeen = (value) => {
  try {
    localStorage.setItem(SEEN, value);
  } catch {}
};

/** Shared for this Mac, followed live; `unseen` counts what arrived from the Mac since Shared was last in front. */
export const shared = {
  store: createStore({ items: [], loaded: false, unseen: 0, error: null }),
  open: false,
  off: null,
  start() {
    if (this.off) return;
    const offMessages = events.listen("shared", () => this.refresh());
    const offConnected = events.whenConnected(() => this.refresh());
    // Back on More with Shared still on top: what arrived meanwhile is seen.
    const offNav = nav.subscribe(() => this.count());
    this.off = () => {
      offMessages();
      offConnected();
      offNav();
    };
    this.refresh();
  },
  stop() {
    this.off?.();
    this.off = null;
  },
  async refresh() {
    try {
      const { items } = await get("/api/shared");
      this.store.set({ items, loaded: true, error: null });
      this.count();
    } catch (e) {
      this.store.set({ error: friendly(e) });
    }
  },
  async add(body) {
    const { items } = await post("/api/shared", body);
    const ids = new Set(items.map((i) => i.id));
    this.store.set({ items: [...items, ...this.store.get().items.filter((i) => !ids.has(i.id))] });
    this.count();
  },
  async remove(item) {
    this.store.set({ items: this.store.get().items.filter((i) => i.id !== item.id) });
    try {
      this.store.set({ items: (await post("/api/shared/remove", { id: item.id })).items });
    } catch (e) {
      this.store.set({ error: friendly(e) });
      this.refresh();
    }
  },
  /** A long note in full. */
  async full(item) {
    return item.partial ? get("/api/shared/item", { id: item.id }) : item;
  },
  setOpen(open) {
    this.open = open;
    this.count();
  },
  count() {
    const items = this.store.get().items;
    const seen = readSeen();
    // Shared in front of you (it stays on top of More while another tab is in
    // front), or the first time on this phone: what is there is not new.
    if ((this.open && nav.get().tab === "more") || seen === null) {
      writeSeen(items[0]?.created ?? "0");
      return this.store.set({ unseen: 0 });
    }
    this.store.set({ unseen: items.filter((i) => i.source === "mac" && i.created > seen).length });
  },
};

function itemIcon(item) {
  if (item.kind === "link") return Link;
  if (item.kind === "text") return AlignLeft;
  const ext = String(item.name || "").split(".").pop().toLowerCase();
  if (ext === "pdf") return FileText;
  if (["png", "jpg", "jpeg", "heic", "gif", "webp"].includes(ext)) return ImageIcon;
  if (["mp4", "mov", "m4v"].includes(ext)) return Film;
  if (["zip", "gz", "tar"].includes(ext)) return FileArchive;
  return File;
}

/** A web address without its scheme, at most 90 characters. */
const address = (url) => {
  const bare = String(url || "").replace(/^https?:\/\/(www\.)?/, "");
  return bare.length > 90 ? bare.slice(0, 90) : bare;
};

/** A note's first three lines, at most 180 characters, cut at a word (never "…"). */
function opening(text) {
  const lines = String(text || "").split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
  if (lines.length <= 180) return lines;
  const head = lines.slice(0, 180);
  const space = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  return space > 100 ? head.slice(0, space) : head;
}

function headline(item) {
  if (item.title) return item.title;
  if (item.kind === "link") return address(item.url);
  if (item.kind === "text") return opening(item.text);
  return item.name || "File";
}

function detail(item, home) {
  if (item.kind === "link") return item.title ? address(item.url) : null;
  if (item.kind === "text") {
    const total = item.length ?? item.text?.length ?? 0;
    const shown = opening(item.text);
    const lines = [item.title ? shown : null, shown.length < total ? `Tap to read all ${total.toLocaleString("en-US")} characters` : null];
    return lines.filter(Boolean).join("\n") || null;
  }
  if (item.exists === false) return `No longer at ${displayPath(item.path, home)}`;
  return [bytes(item.size), item.title ? item.name : null].filter(Boolean).join(" · ") || null;
}

export function SharedScreen() {
  const s = useStore(shared.store);
  const macName = useStore(connection.store, (c) => c.hostStatus?.name || "Mac");
  const home = useHome();
  const toast = useToast();
  const menu = useMenu();
  const dialog = useDialog();
  const [reading, setReading] = useState(null);
  const [writing, setWriting] = useState(false);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(null);
  const fail = (e) => toast(typeof e === "string" ? e : friendly(e), { warning: true });

  useEffect(() => {
    shared.setOpen(true);
    shared.refresh();
    return () => shared.setOpen(false);
  }, []);
  useEffect(() => {
    if (s.error) {
      fail(s.error);
      shared.store.set({ error: null });
    }
  }, [s.error]);

  const origin = (item) => [item.source === "mac" ? `From ${macName}` : `From ${item.device || "this phone"}`, relative(item.created)].filter(Boolean).join(" · ");

  async function copy(item) {
    try {
      if (item.kind === "link") {
        await navigator.clipboard.writeText(item.url);
        return toast("Link copied.");
      }
      const whole = await shared.full(item);
      await navigator.clipboard.writeText(whole.text);
      toast(`Copied (${whole.text.length.toLocaleString("en-US")} characters).`);
    } catch (e) {
      fail(e);
    }
  }
  async function download(item, confirm = false) {
    setBusy(item.id);
    try {
      setSaved(await downloadFile(item, confirm));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }
  async function open(item) {
    if (item.kind === "link") return window.open(item.url, "_blank", "noopener");
    if (item.kind === "text") return setReading(item);
    if (item.exists === false) return fail(`${item.name || "The file"} is no longer at ${displayPath(item.path, home)} on ${macName}.`);
    if (item.sensitive) {
      const ok = await dialog.confirm({ title: `${item.name} holds credentials.`, message: "It will be copied to this phone.", confirmLabel: "Download to this phone" });
      if (ok) download(item, true);
      return;
    }
    download(item);
  }
  async function addMacClipboard() {
    try {
      await shared.add({ macClipboard: true });
      toast("Added the Mac's clipboard.");
    } catch (e) {
      fail(e);
    }
  }
  const itemMenu = (e, item) =>
    menu.open(e.currentTarget, [
      ...(item.kind === "link"
        ? [
            { label: "Open", icon: ExternalLink, action: () => open(item) },
            { label: "Copy link", icon: Copy, action: () => copy(item) },
            ...(navigator.share ? [{ label: "Share", icon: Share, action: () => navigator.share({ url: item.url, title: item.title || undefined }).catch(() => {}) }] : []),
          ]
        : item.kind === "text"
          ? [
              { label: "Copy", icon: Copy, action: () => copy(item) },
              { label: "Read", icon: AlignLeft, action: () => setReading(item) },
            ]
          : [
              { label: "Save to iPhone", icon: File, action: () => open(item) },
              { label: "Copy path", icon: Link, action: () => navigator.clipboard.writeText(item.path).catch(() => {}) },
            ]),
      { label: "Remove", icon: Trash2, destructive: true, action: () => shared.remove(item), id: "shared.remove" },
    ]);

  return (
    <div className="stack-screen">
      <PushedBar
        title="Shared"
        trailing={
          <GlassButton
            icon={SquarePen}
            label="Add"
            id="shared.add"
            onClick={(e) =>
              menu.open(e.currentTarget, [
                { label: "Write a note or link", icon: SquarePen, action: () => setWriting(true), id: "shared.add.note" },
                { label: "Add the Mac's clipboard", icon: ClipboardPaste, action: addMacClipboard, id: "shared.add.clipboard" },
              ])
            }
          />
        }
      />
      <div className="scroll">
        {s.loaded && !s.items.length ? (
          <ContentUnavailable
            icon={Inbox}
            title="Nothing shared yet"
            description={`Links, notes and files sent from ${macName} wait here until you remove them. On the Mac, run palm-share with a link, some text or a file, or ask an agent to share it to your phone.`}
          >
            <GlassTextButton prominent onClick={addMacClipboard} id="shared.empty.clipboard">
              Add the Mac's clipboard
            </GlassTextButton>
          </ContentUnavailable>
        ) : (
          <List>
            <Section>
              {!s.loaded && <Row title={<Spinner />} />}
              {s.items.map((item, index) => {
                const more = detail(item, home);
                return (
                  <Row
                    key={item.id}
                    id={`shared.${item.kind}.${index}`}
                    onClick={() => open(item)}
                    inset={62}
                    leading={
                      <span className="file-glyph" style={{ color: "var(--muted)" }}>
                        <Icon as={itemIcon(item)} size={22} weight={1.8} />
                      </span>
                    }
                    title={
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "pre-line", color: item.exists === false ? "var(--muted)" : undefined }}>
                        {headline(item)}
                        {item.sensitive && <Icon as={KeyRound} size={11} style={{ color: "var(--orange)" }} />}
                      </span>
                    }
                    detail={
                      <span className="t-caption" style={{ whiteSpace: "pre-line" }}>
                        {more ? `${more}\n` : ""}
                        {origin(item)}
                        {busy === item.id && <Spinner />}
                      </span>
                    }
                    trailing={
                      <span
                        role="button"
                        tabIndex={0}
                        className="row-trailing-button"
                        aria-label="More"
                        data-id={`shared.more.${index}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          itemMenu(e, item);
                        }}
                      >
                        <Icon as={Ellipsis} size={18} />
                      </span>
                    }
                  />
                );
              })}
            </Section>
          </List>
        )}
      </div>
      {reading && <NoteSheet item={reading} onClose={() => setReading(null)} onCopy={copy} />}
      {writing && <ComposeSheet onClose={() => setWriting(false)} onAdd={(text) => shared.add({ text })} />}
      {saved && <SavedFileSheet file={saved} onClose={() => setSaved(null)} />}
    </div>
  );
}

/** A note in full: selectable, with Copy and Share. */
function NoteSheet({ item, onClose, onCopy }) {
  const [text, setText] = useState(item.partial ? null : item.text);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (item.partial) shared.full(item).then((full) => setText(full.text), (e) => setError(friendly(e)));
  }, [item]);
  return (
    <Sheet
      title={item.title || "Note"}
      onClose={onClose}
      leading={<DoneButton onClick={onClose} label="Done" id="shared.note.done" />}
      trailing={
        <GlassTextButton prominent onClick={() => onCopy(item)} disabled={text === null} id="shared.note.copy">
          Copy
        </GlassTextButton>
      }
      id="shared.note"
    >
      {text === null && !error && <Spinner large />}
      {error && <p className="t-footnote" style={{ color: "var(--orange)", padding: "0 20px" }}>{error}</p>}
      {text !== null && (
        <div className="shared-note" data-id="shared.note.text">
          {text}
        </div>
      )}
      {text !== null && navigator.share && (
        <List>
          <Section>
            <Row icon={Share} title="Share" accent onClick={() => navigator.share({ text }).catch(() => {})} />
          </Section>
        </List>
      )}
    </Sheet>
  );
}

/** A note or link written on the phone, kept in Shared on the Mac. */
function ComposeSheet({ onClose, onAdd }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function add() {
    setSaving(true);
    try {
      await onAdd(text);
      onClose();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Sheet
      title="New note"
      onClose={onClose}
      leading={<GlassTextButton onClick={onClose}>Cancel</GlassTextButton>}
      trailing={
        saving ? (
          <Spinner />
        ) : (
          <GlassTextButton prominent onClick={add} disabled={!text.trim()} id="shared.compose.add">
            Add
          </GlassTextButton>
        )
      }
      id="shared.compose"
    >
      <div style={{ padding: "0 16px" }}>
        <textarea className="shared-compose" autoFocus value={text} onChange={(e) => setText(e.target.value)} data-id="shared.compose.text" aria-label="Note" />
        <p className="t-footnote" style={{ color: error ? "var(--orange)" : "var(--muted)", margin: "8px 4px" }}>
          {error || "A single web address is kept as a link."}
        </p>
      </div>
    </Sheet>
  );
}

/** The More row's trailing text: "2 new", or how many are kept. */
export function useSharedSummary() {
  const s = useStore(shared.store, (x) => ({ unseen: x.unseen, count: x.items.length }));
  return s.unseen ? `${s.unseen} new` : s.count ? String(s.count) : "";
}

/** The More tab's badge. */
export const useSharedBadge = () => useStore(shared.store, (x) => x.unseen);
