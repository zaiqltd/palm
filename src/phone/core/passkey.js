// Face ID for the web app: a passkey made for this Mac's address, checked by
// the Mac itself (server/webauthn.mjs). Nothing leaves the phone and Mac.
import { access, post, PalmError, readAccess } from "./api.js";

const toBytes = (text) => {
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const toText = (buffer) => {
  if (!buffer) return null;
  let s = "";
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export async function passkeysAvailable() {
  try {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

function explain(error) {
  if (error instanceof PalmError) return error;
  if (error?.name === "NotAllowedError") return new PalmError("Face ID was cancelled or timed out. Try again.");
  if (error?.name === "InvalidStateError") return new PalmError("A passkey for Palm is already on this phone. Try Unlock instead.");
  if (error?.name === "SecurityError") return new PalmError("Face ID needs Palm's private HTTPS address (the one ending in .ts.net).");
  if (error?.name === "NotSupportedError") return new PalmError("This browser cannot make a passkey. Use Safari, with iCloud Keychain turned on.");
  return new PalmError(error?.message || "Face ID did not work. Try again.");
}

/** Right after pairing: make this phone's passkey for Palm. */
export async function setUpFaceID() {
  try {
    const { publicKey } = await post("/api/web/passkey/options", { purpose: "register" });
    const credential = await navigator.credentials.create({
      publicKey: { ...publicKey, challenge: toBytes(publicKey.challenge), user: { ...publicKey.user, id: toBytes(publicKey.user.id) } },
    });
    await post("/api/web/passkey/register", {
      credential: {
        id: credential.id,
        rawId: toText(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: toText(credential.response.clientDataJSON),
          attestationObject: toText(credential.response.attestationObject),
        },
      },
    });
    access.set({ state: "unlocked" });
  } catch (error) {
    throw explain(error);
  } finally {
    readAccess().catch(() => {});
  }
}

/** Opening Palm after ten idle minutes: Face ID, then the Mac unlocks it. */
export async function unlockWithFaceID() {
  try {
    const { publicKey } = await post("/api/web/passkey/options", { purpose: "unlock" });
    const credential = await navigator.credentials.get({
      publicKey: {
        ...publicKey,
        challenge: toBytes(publicKey.challenge),
        allowCredentials: publicKey.allowCredentials.map((c) => ({ ...c, id: toBytes(c.id) })),
      },
    });
    await post("/api/web/passkey/unlock", {
      credential: {
        id: credential.id,
        rawId: toText(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: toText(credential.response.clientDataJSON),
          authenticatorData: toText(credential.response.authenticatorData),
          signature: toText(credential.response.signature),
          userHandle: toText(credential.response.userHandle),
        },
      },
    });
    access.set({ state: "unlocked" });
  } catch (error) {
    throw explain(error);
  }
}

export async function lockNow() {
  await post("/api/web/lock", {}).catch(() => {});
  access.set({ state: "locked" });
}
