// Files between this phone and the Mac, each one proven intact (PalmTransfers):
// the phone hashes what it sends and the Mac what it wrote (uploads), and the
// reverse for downloads. A mismatch is a failure, never a silent partial file.
import { PalmError, friendly, get } from "./api.js";
import { createStore } from "./store.js";

const sanitize = (name) => {
  const cleaned = String(name || "").replaceAll("/", "-").replaceAll("\0", "").trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "File" : cleaned.slice(0, 200);
};

export async function sha256(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class PalmTransfers {
  store = createStore({ items: [] });

  get items() {
    return this.store.get().items;
  }
  add(item) {
    this.store.set({ items: [item, ...this.items].slice(0, 100) });
    return item.id;
  }
  update(id, change) {
    this.store.set({ items: this.items.map((i) => (i.id === id ? { ...i, ...change } : i)) });
  }
  clearFinished() {
    this.store.set({ items: this.items.filter((i) => i.state !== "verified" && i.state !== "failed") });
  }

  /** A file (or Blob with a name) into a Mac folder; the Mac's result when verified, else null. */
  async upload(file, folder, name = file.name, conflict = "rename") {
    const fileName = sanitize(name);
    const id = this.add({ id: crypto.randomUUID(), direction: "toMac", name: fileName, destination: folder, size: file.size, state: "preparing", progress: 0 });
    try {
      const digest = await sha256(file);
      this.update(id, { sha256: digest, state: "transferring" });
      const query = new URLSearchParams({ dir: folder, name: fileName, conflict, sha256: digest, size: String(file.size) });
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `/api/fs/upload?${query}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.upload.onprogress = (e) => e.lengthComputable && this.update(id, { progress: e.loaded / e.total });
        xhr.onload = () => {
          let body = null;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {}
          if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
          else reject(new PalmError(body?.error || `The Mac refused the upload (${xhr.status}).`, { status: xhr.status }));
        };
        xhr.onerror = () => reject(new PalmError("The upload was cut off. Check the connection and try again."));
        xhr.send(file);
      });
      this.update(id, { state: "verifying" });
      if (!result.verified || result.sha256 !== digest || result.size !== file.size) throw new PalmError("The Mac's copy does not match the phone's file.");
      this.update(id, { state: "verified", macPath: result.path, name: result.name });
      return result;
    } catch (error) {
      this.update(id, { state: "failed", message: friendly(error) });
      return null;
    }
  }

  /** A Mac file to this phone, verified: { blob, name } or null. */
  async download(macPath, confirmSensitive = false) {
    const name = sanitize(macPath.split("/").pop());
    const id = this.add({ id: crypto.randomUUID(), direction: "toPhone", name, destination: "phone", size: 0, state: "transferring", progress: 0, macPath });
    try {
      const query = new URLSearchParams({ path: macPath });
      if (confirmSensitive) query.set("confirm", "1");
      const response = await fetch(`/api/fs/download?${query}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        let message = `The Mac refused the download (${response.status}).`;
        try {
          message = (await response.json()).error || message;
        } catch {}
        throw new PalmError(message, { status: response.status });
      }
      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) this.update(id, { progress: received / total });
      }
      const blob = new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
      this.update(id, { state: "verifying" });
      const remote = await get("/api/fs/hash", Object.fromEntries(query));
      const local = await sha256(blob);
      if (local !== remote.sha256 || blob.size !== remote.size) throw new PalmError("The downloaded copy does not match the Mac's file (it may have changed while downloading).");
      const url = URL.createObjectURL(blob);
      this.update(id, { state: "verified", size: blob.size, sha256: local, url, blob });
      return { blob, name, url, id };
    } catch (error) {
      this.update(id, { state: "failed", message: friendly(error) });
      return null;
    }
  }
}

export const transfers = new PalmTransfers();
