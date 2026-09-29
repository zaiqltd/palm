// A software passkey for tests: what an iPhone's Face ID passkey sends, made
// with WebCrypto (P-256, "none" attestation, user verified). Runs in Node and
// in a browser page (the web app's walk-throughs install it in place of
// navigator.credentials, since test browsers have no Face ID).

const enc = new TextEncoder();
const b64u = {
  encode(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  },
  decode(text) {
    const s = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

// ---- CBOR encoder: the handful of types WebAuthn uses ----
function head(major, n) {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
}
export function cbor(value) {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = enc.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return concat(...parts);
  }
  throw new Error("cbor: unsupported value");
}

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

/** ECDSA's raw r||s (WebCrypto) as the DER sequence WebAuthn carries. */
function derSignature(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

/**
 * options: { origin, rpId?, userVerified = true, signCount = 0 }
 * create(publicKey) and get(publicKey) take the options the Mac sent (with
 * base64url strings) and return the JSON the web app posts back.
 */
export async function softAuthenticator({ origin, rpId, userVerified = true, signCount = 0, saved = null } = {}) {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const pair = saved
    ? {
        privateKey: await crypto.subtle.importKey("jwk", saved.privateJwk, algorithm, true, ["sign"]),
        publicKey: await crypto.subtle.importKey("jwk", saved.publicJwk, algorithm, true, ["verify"]),
      }
    : await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const credentialId = saved ? b64u.decode(saved.id) : crypto.getRandomValues(new Uint8Array(32));
  let counter = signCount;
  const flags = (attested) => (0x01 | (userVerified ? 0x04 : 0) | (attested ? 0x40 : 0));
  const clientData = (type, challenge) =>
    enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const idText = b64u.encode(credentialId);
  return {
    id: idText,
    async save() {
      return {
        id: idText,
        privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
        publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
      };
    },
    async create(publicKey, overrides = {}) {
      const rp = overrides.rpId ?? rpId ?? publicKey.rp.id;
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, b64u.decode(jwk.x)], [-3, b64u.decode(jwk.y)]]));
      const authData = concat(
        await sha256(enc.encode(rp)),
        Uint8Array.of(overrides.flags ?? flags(true)),
        Uint8Array.of(0, 0, 0, counter),
        new Uint8Array(16),
        Uint8Array.of(credentialId.length >> 8, credentialId.length & 255),
        credentialId,
        cose,
      );
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return {
        id: idText, rawId: idText, type: "public-key",
        response: {
          clientDataJSON: b64u.encode(clientData(overrides.type ?? "webauthn.create", overrides.challenge ?? publicKey.challenge)),
          attestationObject: b64u.encode(attestationObject),
        },
      };
    },
    async get(publicKey, overrides = {}) {
      const rp = overrides.rpId ?? rpId ?? publicKey.rpId;
      counter += overrides.counterStep ?? 0;
      const authData = concat(
        await sha256(enc.encode(rp)),
        Uint8Array.of(overrides.flags ?? flags(false)),
        Uint8Array.of((counter >>> 24) & 255, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255),
      );
      const client = clientData(overrides.type ?? "webauthn.get", overrides.challenge ?? publicKey.challenge);
      const signed = concat(authData, await sha256(client));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
      const signature = derSignature(raw);
      if (overrides.tamper) signature[signature.length - 1] ^= 1;
      return {
        id: overrides.id ?? idText, rawId: overrides.id ?? idText, type: "public-key",
        response: {
          clientDataJSON: b64u.encode(client),
          authenticatorData: b64u.encode(authData),
          signature: b64u.encode(signature),
          userHandle: null,
        },
      };
    },
  };
}

/**
 * Installs a software passkey as navigator.credentials in a page, returning
 * what a real browser returns (ArrayBuffers), so the web app's own conversion
 * code runs. Used by the web app's walk-throughs.
 */
export function installInPage() {
  let authenticator;
  const toBuffers = (json) => ({
    id: json.id,
    rawId: b64u.decode(json.rawId).buffer,
    type: json.type,
    response: Object.fromEntries(
      Object.entries(json.response).map(([k, v]) => [k, typeof v === "string" ? b64u.decode(v).buffer : v]),
    ),
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: "platform",
  });
  const fromBuffers = (publicKey) => {
    const text = (v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? b64u.encode(new Uint8Array(v.buffer ?? v)) : v);
    return { ...publicKey, challenge: text(publicKey.challenge), user: publicKey.user && { ...publicKey.user, id: text(publicKey.user.id) } };
  };
  const key = "__palmSoftPasskey";
  const credentials = {
    async create({ publicKey }) {
      authenticator = await softAuthenticator({ origin: location.origin });
      localStorage.setItem(key, JSON.stringify(await authenticator.save()));
      window.__palmPasskeyUses = (window.__palmPasskeyUses || 0) + 1;
      return toBuffers(await authenticator.create(fromBuffers(publicKey)));
    },
    async get({ publicKey }) {
      if (!authenticator && localStorage.getItem(key))
        authenticator = await softAuthenticator({ origin: location.origin, saved: JSON.parse(localStorage.getItem(key)) });
      if (!authenticator) throw new DOMException("No passkey", "NotAllowedError");
      window.__palmPasskeyUses = (window.__palmPasskeyUses || 0) + 1;
      return toBuffers(await authenticator.get(fromBuffers(publicKey)));
    },
  };
  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
  window.PublicKeyCredential = window.PublicKeyCredential || function PublicKeyCredential() {};
  window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
}

export { b64u };
