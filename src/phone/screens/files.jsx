// The Files tab (PalmMacFilesView): send anything from this phone to a Mac
// folder, save anything from the Mac to this phone, every transfer verified;
// browse, search, sort, rename, move, copy and trash on the Mac.
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpDown,
  ArrowUpFromLine,
  BadgeCheck,
  ClipboardCopy,
  Clock,
  Copy,
  CornerUpRight,
  Download,
  Ellipsis,
  Eye,
  File,
  FileArchive,
  FileCode,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Home,
  Image as ImageIcon,
  KeyRound,
  Link,
  Monitor,
  Package,
  Pencil,
  CirclePlus,
  Share,
  Trash2,
  TriangleAlert,
  Type,
  Upload,
  Files as FilesIcon,
} from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { connection } from "../core/connection.js";
import { bytes, displayPath, relative } from "../core/format.js";
import { nav, navigate } from "../core/navigator.js";
import { usePref, KEYS } from "../core/prefs.js";
import { useStore } from "../core/store.js";
import { timings } from "../core/timings.js";
import { transfers } from "../core/transfers.js";
import { BackButton, DoneButton, GlassButton, GlassTextButton, Icon, List, NavBar, PrimaryButton, Row, SearchField, Section, Sheet, Spinner, cx, useDialog, useMenu, useToast } from "../ui/kit.jsx";
import { deviceSubtitle } from "./common.jsx";

const PLACE_ICONS = { house: Home, desktopcomputer: Monitor, "doc.text": FileText, doc: FileText, "arrow.down.circle": ArrowDownToLine, folder: Folder, "tray.and.arrow.down": ArrowDownToLine, externaldrive: Package };
const TEXT_LIKE = ["txt", "md", "json", "js", "mjs", "ts", "tsx", "jsx", "swift", "py", "css", "html", "sh", "yml", "yaml", "toml", "log", "csv", "env", "xml", "plist"];
const ext = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tiff", "bmp"];
/** The Mac lists kind "folder" or "file"; an app bundle is a package, not a folder to open. */
const item = (i) => ({ ...i, isFolder: i.kind === "folder" && !i.package, isImage: IMAGE_EXTENSIONS.includes(ext(i.name)) });
const listingOf = (l) => ({ ...l, items: (l.items || []).map(item) });

export function useHome() {
  return useStore(connection.store, (s) => s.hostStatus?.home ?? null);
}

/** Download a Mac file to this phone (verified), then offer it: open, share or save. */
export async function downloadFile(item, confirm = false) {
  const result = await transfers.download(item.path, confirm);
  if (!result) throw new Error(transfers.items[0]?.message || "The download failed.");
  return result;
}

/** A downloaded file: open it, share it (Save to Files or Photos), or download it. */
export function SavedFileSheet({ file, onClose }) {
  const canShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [new window.File([file.blob], file.name, { type: file.blob.type })] });
  const media = /^(image|video)\//.test(file.blob.type);
  return (
    <Sheet title="Saved to this phone" onClose={onClose} trailing={<DoneButton onClick={onClose} />} detent="medium" id="files.saved">
      <List>
        <Section>
          <Row
            icon={media ? ImageIcon : File}
            title={<span className="t-headline">{file.name}</span>}
            detail={
              <span className="t-caption" style={{ color: "var(--success)", display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Icon as={BadgeCheck} size={13} /> On this phone, verified
              </span>
            }
          />
        </Section>
        <Section>
          <Row icon={Eye} title="Open" accent onClick={() => window.open(file.url, "_blank")} />
          {canShare && (
            <Row
              icon={Share}
              title={media ? "Save to Photos or Files" : "Save to Files or share"}
              accent
              onClick={() => navigator.share({ files: [new window.File([file.blob], file.name, { type: file.blob.type })] }).catch(() => {})}
            />
          )}
          <Row
            icon={Download}
            title="Download"
            accent
            onClick={() => {
              const a = document.createElement("a");
              a.href = file.url;
              a.download = file.name;
              a.click();
            }}
          />
        </Section>
      </List>
    </Sheet>
  );
}

function TransferState({ item }) {
  if (item.state === "verified") return <Icon as={BadgeCheck} size={18} style={{ color: "var(--success)" }} aria-label="Verified" />;
  if (item.state === "failed") return <Icon as={TriangleAlert} size={18} style={{ color: "var(--orange)" }} aria-label="Failed" />;
  if (item.state === "transferring") return <span className="t-caption muted" style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round((item.progress || 0) * 100)}%</span>;
  return <Spinner />;
}

function TransferRow({ item, home, onOpen }) {
  return (
    <Row
      icon={item.direction === "toMac" ? ArrowUpFromLine : ArrowDownToLine}
      title={item.name}
      detail={<span className="t-caption">{item.direction === "toMac" ? `To ${displayPath(item.macPath ?? item.destination, home)}` : "To this phone"}</span>}
      trailing={<TransferState item={item} />}
      onClick={item.direction === "toPhone" && item.state === "verified" ? () => onOpen(item) : undefined}
    />
  );
}

export function FilesTab() {
  const s = useStore(connection.store, (s) => ({ hostStatus: s.hostStatus, connectionState: s.connectionState }));
  const home = useHome();
  const t = useStore(transfers.store);
  const requested = useStore(nav, (n) => n.filesFolder);
  const [places, setPlaces] = useState([]);
  const [sending, setSending] = useState(false);
  const [showingTransfers, setShowingTransfers] = useState(false);
  const [saved, setSaved] = useState(null);
  const toast = useToast();
  async function load() {
    try {
      setPlaces((await get("/api/fs/places")).places || []);
    } catch (e) {
      toast(friendly(e), { warning: true });
    }
  }
  useEffect(() => {
    load();
  }, []);
  // The assistant's "Show in Files" opens that folder here.
  useEffect(() => {
    if (!requested) return;
    nav.set({ filesFolder: null });
    navigate.push("folder", { folder: requested });
  }, [requested]);
  const homeFolder = places.find((p) => p.symbol === "house")?.path ?? home ?? "~";
  return (
    <div className="stack-screen">
      <NavBar title="Files" subtitle={deviceSubtitle(s)} />
      <div className="scroll">
        <List>
          <div className="bridge">
            <button type="button" className="bridge-button" onClick={() => setSending(true)} data-id="files.send">
              <Icon as={ArrowUp} size={24} weight={2.4} className="bridge-icon" />
              <span className="t-headline">Send to Mac</span>
              <span className="t-caption muted">Photos, files, copied items</span>
            </button>
            <button type="button" className="bridge-button" onClick={() => navigate.push("folder", { folder: homeFolder })} data-id="files.save">
              <Icon as={ArrowDown} size={24} weight={2.4} className="bridge-icon" />
              <span className="t-headline">Save to iPhone</span>
              <span className="t-caption muted">Pick any file on the Mac</span>
            </button>
          </div>
          {t.items.length > 0 && (
            <Section header="Recent transfers">
              {t.items.slice(0, 5).map((item) => (
                <TransferRow key={item.id} item={item} home={home} onOpen={(i) => setSaved({ blob: i.blob, name: i.name, url: i.url })} />
              ))}
              {t.items.length > 5 && <Row title={`All transfers (${t.items.length})`} accent onClick={() => setShowingTransfers(true)} />}
            </Section>
          )}
          <Section header="On your Mac">
            {places.map((p) => (
              <Row key={p.path} icon={PLACE_ICONS[p.symbol] ?? Folder} title={p.name} chevron onClick={() => navigate.push("folder", { folder: p.path })} id={`files.place.${p.name}`} />
            ))}
          </Section>
        </List>
      </div>
      {sending && (
        <SendSheet
          onClose={(folder) => {
            setSending(false);
            if (folder) navigate.push("folder", { folder });
          }}
        />
      )}
      {showingTransfers && <TransfersSheet onClose={() => setShowingTransfers(false)} onOpen={(i) => setSaved({ blob: i.blob, name: i.name, url: i.url })} />}
      {saved && <SavedFileSheet file={saved} onClose={() => setSaved(null)} />}
    </div>
  );
}

/** Pick files (photos, videos or anything from Files) with the browser's own picker. */
function usePicker(onFiles, accept) {
  const input = useRef(null);
  const element = (
    <input
      ref={input}
      type="file"
      multiple
      accept={accept}
      style={{ display: "none" }}
      onChange={(e) => {
        const files = [...e.target.files];
        e.target.value = "";
        if (files.length) onFiles(files);
      }}
    />
  );
  return [element, () => input.current?.click()];
}

function SendSheet({ onClose }) {
  const home = useHome();
  const [destination, setDestination] = usePref(KEYS.sendFolder, "");
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState([]);
  const [note, setNote] = useState(null);
  const t = useStore(transfers.store);
  useEffect(() => {
    if (!destination) get("/api/fs/places").then((p) => setDestination(p.inbox)).catch(() => {});
  }, []);
  async function send(files) {
    setBusy(true);
    try {
      for (const file of files) {
        const before = new Set(transfers.items.map((i) => i.id));
        const upload = transfers.upload(file, destination);
        await new Promise((r) => setTimeout(r, 50));
        const added = transfers.items.find((i) => !before.has(i.id));
        if (added) setSent((list) => [...list, added.id]);
        await upload;
      }
    } finally {
      setBusy(false);
    }
  }
  const [photoInput, pickPhotos] = usePicker(send, "image/*,video/*");
  const [fileInput, pickFiles] = usePicker(send);
  async function sendPasted() {
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", ".");
    try {
      const items = navigator.clipboard.read ? await navigator.clipboard.read() : [];
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) return send([new window.File([await item.getType(imageType)], `Pasted ${stamp}.png`, { type: imageType })]);
        if (item.types.includes("text/plain")) return send([new window.File([await item.getType("text/plain")], `Pasted ${stamp}.txt`, { type: "text/plain" })]);
      }
      const text = await navigator.clipboard.readText();
      if (text) return send([new window.File([text], `Pasted ${stamp}.txt`, { type: "text/plain" })]);
      setNote("Nothing Palm can send was on this phone's clipboard.");
    } catch {
      setNote("Allow Paste to send what this phone copied.");
    }
  }
  const batch = t.items.filter((i) => sent.includes(i.id));
  const allVerified = batch.length > 0 && batch.every((i) => i.state === "verified");
  return (
    <Sheet
      title="Send to Mac"
      onClose={() => onClose(null)}
      leading={<GlassTextButton onClick={() => onClose(null)}>Close</GlassTextButton>}
      trailing={allVerified ? <GlassTextButton prominent onClick={() => onClose(destination)}>Show on Mac</GlassTextButton> : null}
      id="files.sendSheet"
    >
      {photoInput}
      {fileInput}
      <List>
        <Section header="To this Mac folder">
          <Row icon={Folder} title={destination ? destination.split("/").pop() || destination : "Choose a folder"} value={<span className="t-caption">{displayPath(destination, home)}</span>} onClick={() => setChoosing(true)} />
        </Section>
        <Section header="From this phone">
          <Row icon={ImageIcon} title="Photos and videos" accent disabled={!destination || busy} onClick={pickPhotos} id="send.photos" />
          <Row icon={FileText} title="Files" accent disabled={!destination || busy} onClick={pickFiles} id="send.files" />
          <Row icon={ClipboardCopy} title="Paste" accent disabled={!destination || busy} onClick={sendPasted} id="send.paste" />
        </Section>
        {note && <Row title={<span className="t-footnote muted">{note}</span>} />}
        {batch.length > 0 && (
          <Section header="Sent">
            {batch.map((item) => (
              <TransferRow key={item.id} item={item} home={home} onOpen={() => {}} />
            ))}
          </Section>
        )}
      </List>
      {choosing && <FolderPicker title="Send to" start={destination || "~"} onChoose={(f) => setDestination(f)} onClose={() => setChoosing(false)} />}
    </Sheet>
  );
}

function TransfersSheet({ onClose, onOpen }) {
  const t = useStore(transfers.store);
  const home = useHome();
  return (
    <Sheet title="Transfers" onClose={onClose} leading={<GlassTextButton onClick={() => transfers.clearFinished()}>Clear finished</GlassTextButton>} trailing={<DoneButton onClick={onClose} />}>
      <List>
        <Section>
          {!t.items.length && <Row title={<span className="muted">Nothing transferred yet.</span>} />}
          {t.items.map((item) => (
            <Row
              key={item.id}
              icon={item.direction === "toMac" ? ArrowUpFromLine : ArrowDownToLine}
              title={<span className="w-medium">{item.name}</span>}
              detail={
                <span className="t-caption">
                  {item.direction === "toMac" ? `To ${displayPath(item.macPath ?? item.destination, home)}` : `From ${displayPath(item.macPath ?? "", home)}`}
                  {item.state === "verified" && item.sha256 && (
                    <span className="mono" style={{ display: "block", color: "var(--accent)" }}>
                      SHA-256 {item.sha256.slice(0, 16)} matches on both devices{item.size > 0 ? ` · ${bytes(item.size)}` : ""}
                    </span>
                  )}
                  {item.state === "failed" && <span style={{ display: "block", color: "var(--orange)" }}>{item.message}</span>}
                </span>
              }
              trailing={<TransferState item={item} />}
              onClick={item.direction === "toPhone" && item.state === "verified" ? () => onOpen(item) : undefined}
            />
          ))}
        </Section>
      </List>
    </Sheet>
  );
}

/** Choose a destination folder on the Mac (PalmFolderPicker). */
export function FolderPicker({ title, start, onChoose, onClose }) {
  const [listing, setListing] = useState(null);
  const [places, setPlaces] = useState([]);
  const [error, setError] = useState(null);
  async function open(folder) {
    try {
      setListing(listingOf(await get("/api/fs/list", { path: folder })));
      setError(null);
    } catch (e) {
      setError(friendly(e));
    }
  }
  useEffect(() => {
    get("/api/fs/places")
      .then((p) => setPlaces(p.places || []))
      .catch(() => {});
    open(start);
  }, []);
  return (
    <Sheet title={title} onClose={onClose} leading={<GlassTextButton onClick={onClose}>Cancel</GlassTextButton>} id="files.folderPicker">
      <div className="chips">
        {places.map((p) => (
          <button key={p.path} type="button" className="capsule-button" onClick={() => open(p.path)}>
            {p.name}
          </button>
        ))}
      </div>
      <List>
        <Section>
          {error && <Row title={<span className="warning">{error}</span>} />}
          {listing?.parent && <Row icon={ArrowUp} title={`Up to ${listing.parent.split("/").pop() || "/"}`} accent onClick={() => open(listing.parent)} />}
          {(listing?.items ?? [])
            .filter((i) => i.isFolder)
            .map((i) => (
              <Row key={i.path} icon={Folder} title={i.name} accent onClick={() => open(i.path)} />
            ))}
        </Section>
      </List>
      <div className="sheet-footer">
        <PrimaryButton
          disabled={!listing}
          onClick={() => {
            onChoose(listing.path);
            onClose();
          }}
          id="folderPicker.choose"
        >
          Choose {listing?.name ?? "this folder"}
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

const SORTS = [
  ["recent", "Recent", Clock],
  ["name", "Name", Type],
  ["size", "Size", ArrowDownToLine],
  ["kind", "Kind", FilesIcon],
];
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
function sorted(items, order) {
  const list = [...items];
  if (order === "name") return list.sort((a, b) => (a.isFolder !== b.isFolder ? (a.isFolder ? -1 : 1) : byName(a, b)));
  if (order === "size")
    return list.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (a.isFolder) return byName(a, b);
      return (a.size ?? 0) !== (b.size ?? 0) ? (b.size ?? 0) - (a.size ?? 0) : byName(a, b);
    });
  if (order === "kind")
    return list.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return ext(a.name) !== ext(b.name) ? (ext(a.name) < ext(b.name) ? -1 : 1) : byName(a, b);
    });
  return list.sort((a, b) => {
    if (a.modified && b.modified && a.modified !== b.modified) return a.modified > b.modified ? -1 : 1;
    if (a.modified && !b.modified) return -1;
    if (!a.modified && b.modified) return 1;
    return byName(a, b);
  });
}
function itemIcon(item) {
  if (item.isFolder) return Folder;
  if (item.package) return Package;
  if (item.isImage) return ImageIcon;
  const e = ext(item.name);
  if (e === "pdf") return FileText;
  if (["zip", "gz", "tar"].includes(e)) return FileArchive;
  if (["mp4", "mov", "m4v"].includes(e)) return Film;
  if (["js", "mjs", "ts", "tsx", "jsx", "swift", "py", "json", "css", "html", "sh", "yml", "md"].includes(e)) return FileCode;
  return File;
}

/** One Mac folder (PalmFolderView). */
export function FolderScreen({ folder }) {
  const home = useHome();
  const [listing, setListing] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState(null);
  const [sortOrder, setSortOrder] = usePref("palm.files.sort", "recent");
  const [textPreview, setTextPreview] = useState(null);
  const [moving, setMoving] = useState(null);
  const [saved, setSaved] = useState(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const dialog = useDialog();
  const menu = useMenu();
  const fail = (e) => toast(friendly(e), { warning: true });

  async function load() {
    setLoading(true);
    try {
      const asked = performance.now();
      setListing(listingOf(await get("/api/fs/list", { path: folder, hidden: showHidden ? "1" : "0" })));
      timings.record("filesFolder", performance.now() - asked);
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [folder, showHidden]);
  const [photoInput, pickPhotos] = usePicker(async (files) => {
    for (const f of files) await transfers.upload(f, listing?.path ?? folder);
    load();
  }, "image/*,video/*");
  const [fileInput, pickFiles] = usePicker(async (files) => {
    for (const f of files) await transfers.upload(f, listing?.path ?? folder);
    load();
  });

  const isHome = (listing?.path ?? folder) === home || folder === "~";
  const title = isHome ? "Home" : listing?.name ?? folder.split("/").pop();
  const items = sorted(results ?? listing?.items ?? [], sortOrder);

  async function runSearch() {
    if (!search.trim()) return setResults(null);
    try {
      setResults(((await get("/api/fs/search", { path: folder, q: search })).items || []).map(item));
    } catch (e) {
      fail(e);
    }
  }
  async function download(item, confirm = false) {
    try {
      setSaved(await downloadFile(item, confirm));
    } catch (e) {
      fail(e);
    }
  }
  async function open(item) {
    if (item.isFolder) return navigate.push("folder", { folder: item.path });
    if (item.sensitive) {
      const ok = await dialog.confirm({ title: `${item.name} holds credentials.`, message: "Only continue if you need this secret on your phone.", confirmLabel: "Download to this phone" });
      if (ok) download(item, true);
      return;
    }
    if ((TEXT_LIKE.includes(ext(item.name)) || item.name.startsWith(".")) && (item.size ?? 0) < 512 * 1024) {
      try {
        return setTextPreview(await get("/api/fs/preview", { path: item.path }));
      } catch {}
    }
    download(item);
  }
  async function rename(item) {
    const name = await dialog.prompt({ title: "Rename", value: item.name, placeholder: "Name", confirmLabel: "Rename" });
    if (!name) return;
    try {
      await post("/api/fs/rename", { path: item.path, name });
      load();
    } catch (e) {
      fail(e);
    }
  }
  async function makeFolder() {
    const name = await dialog.prompt({ title: "New folder", placeholder: "Folder name", confirmLabel: "Create" });
    if (!name) return;
    try {
      await post("/api/fs/mkdir", { path: listing?.path ?? folder, name });
      load();
    } catch (e) {
      fail(e);
    }
  }
  async function trash(item) {
    const ok = await dialog.confirm({ title: `Move ${item.name} to the Trash on your Mac?`, message: "You can put it back from the Mac's Trash.", confirmLabel: "Move to Trash", destructive: true });
    if (!ok) return;
    try {
      await post("/api/fs/trash", { paths: [item.path] });
      load();
    } catch (e) {
      fail(e);
    }
  }
  async function transfer(item, to, mode) {
    try {
      await post(`/api/fs/${mode}`, { paths: [item.path], to });
      load();
    } catch (e) {
      fail(e);
    }
  }
  const itemMenu = (e, item) =>
    menu.open(e.currentTarget, [
      ...(item.isFolder ? [] : [{ label: "Save to iPhone", icon: ArrowDownToLine, action: () => download(item) }]),
      { label: "Copy on Mac (for Finder paste)", icon: ClipboardCopy, action: () => post("/api/clipboard", { files: [item.path] }).catch(fail) },
      { label: "Copy path", icon: Link, action: () => navigator.clipboard.writeText(item.path).catch(() => {}) },
      { label: "Copy to", icon: Copy, action: () => setMoving({ item, mode: "copy" }) },
      { label: "Move to", icon: Folder, action: () => setMoving({ item, mode: "move" }) },
      { label: "Rename", icon: Pencil, action: () => rename(item) },
      { label: "Move to Trash", icon: Trash2, destructive: true, action: () => trash(item) },
    ]);
  return (
    <div className="stack-screen">
      <NavBar
        inline
        title={title}
        leading={<BackButton onClick={() => navigate.pop()} />}
        trailing={
          <>
            <GlassButton
              icon={ArrowUpDown}
              label="Sort"
              id="files.sort"
              onClick={(e) => menu.open(e.currentTarget, SORTS.map(([id, label, icon]) => ({ label, icon, checked: sortOrder === id, action: () => setSortOrder(id) })))}
            />
            <GlassButton
              icon={CirclePlus}
              label="Add"
              id="files.add"
              onClick={(e) =>
                menu.open(e.currentTarget, [
                  { label: "Upload photos here", icon: ImageIcon, action: pickPhotos, id: "files.uploadPhotos" },
                  { label: "Upload files here", icon: Upload, action: pickFiles },
                  { label: "New folder", icon: FolderPlus, action: makeFolder },
                  { label: "Show hidden files", checked: showHidden, action: () => setShowHidden((v) => !v) },
                  { label: "Copy folder path", icon: Copy, action: () => navigator.clipboard.writeText(listing?.path ?? folder).catch(() => {}) },
                ])
              }
            />
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <SearchField
            value={search}
            onChange={(v) => {
              setSearch(v);
              if (!v) setResults(null);
            }}
            placeholder="Search this folder (Spotlight)"
            id="files.search"
          />
        </form>
      </NavBar>
      {photoInput}
      {fileInput}
      <div className="scroll">
        <List>
          {listing?.hiddenCount > 0 && !showHidden && !results && (
            <button type="button" className="plain-link t-footnote" onClick={() => setShowHidden(true)}>
              Show {listing.hiddenCount} hidden item{listing.hiddenCount === 1 ? "" : "s"}
            </button>
          )}
          <Section>
            {!listing && loading && <Row title={<Spinner />} />}
            {items.map((item) => {
              const meta = [item.size != null && !item.isFolder ? bytes(item.size) : null, relative(item.modified)].filter(Boolean).join(" · ");
              return (
                <Row
                  key={item.path}
                  onClick={() => open(item)}
                  id={`fs.${item.name}`}
                  leading={
                    <span className="file-glyph" style={{ color: item.isFolder ? "var(--accent)" : "var(--muted)" }}>
                      <Icon as={itemIcon(item)} size={22} weight={1.8} fill={item.isFolder ? "currentColor" : "none"} />
                    </span>
                  }
                  inset={62}
                  title={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: item.hidden ? "var(--muted)" : undefined }}>
                      {item.name}
                      {item.symlink && <Icon as={CornerUpRight} size={11} style={{ color: "var(--muted)" }} />}
                      {item.sensitive && <Icon as={KeyRound} size={11} style={{ color: "var(--orange)" }} />}
                    </span>
                  }
                  detail={meta ? <span className="t-caption">{meta}</span> : undefined}
                  trailing={
                    <span
                      role="button"
                      tabIndex={0}
                      className="row-trailing-button"
                      aria-label={`More for ${item.name}`}
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
            {listing && !items.length && <Row title={<span className="muted">{results ? "No matches." : "This folder is empty."}</span>} />}
          </Section>
        </List>
      </div>
      {textPreview && (
        <Sheet title={textPreview.path.split("/").pop()} onClose={() => setTextPreview(null)} trailing={<DoneButton onClick={() => setTextPreview(null)} />}>
          <pre className="text-preview">{textPreview.text ?? ""}</pre>
        </Sheet>
      )}
      {moving && (
        <FolderPicker
          title={moving.mode === "move" ? "Move to" : "Copy to"}
          start={listing?.path ?? folder}
          onChoose={(to) => transfer(moving.item, to, moving.mode)}
          onClose={() => setMoving(null)}
        />
      )}
      {saved && <SavedFileSheet file={saved} onClose={() => setSaved(null)} />}
    </div>
  );
}
