// Passkeys (WebAuthn) for Palm's web app: Face ID on the phone unlocks a web
// pairing. The Mac checks everything itself; nothing goes to a third party.
//
// Deliberately small and strict: ES256 (P-256) keys only, user verification
// required, the exact origin and site name checked, one-time challenges.
// Attestation is not requested ("none"), so no vendor certificate is trusted.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

export const b64u = {
  encode: (buffer) => Buffer.from(buffer).toString("base64url"),
  decode(value, limit = 65536) {
    if (typeof value !== "string" || value.length > limit || !/^[A-Za-z0-9_-]*$/.test(value))
      throw new Error("The passkey reply is malformed.");
    return Buffer.from(value, "base64url");
  },
};

const sha256 = (data) => createHash("sha256").update(data).digest();

// ---- CBOR: definite lengths, the types WebAuthn uses, bounded depth ----

export function cborDecode(buffer, offset = 0, depth = 0) {
  if (depth > 8) throw new Error("The passkey data is nested too deeply.");
  if (offset >= buffer.length) throw new Error("The passkey data ended early.");
  const first = buffer[offset++];
  const major = first >> 5;
  const info = first & 31;
  let length;
  const need = (n) => {
    if (offset + n > buffer.length) throw new Error("The passkey data ended early.");
  };
  if (info < 24) length = info;
  else if (info === 24) (need(1), (length = buffer[offset]), (offset += 1));
  else if (info === 25) (need(2), (length = buffer.readUInt16BE(offset)), (offset += 2));
  else if (info === 26) (need(4), (length = buffer.readUInt32BE(offset)), (offset += 4));
  else if (info === 27) {
    need(8);
    const big = buffer.readBigUInt64BE(offset);
    offset += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The passkey data has an oversized number.");
    length = Number(big);
  } else throw new Error("Indefinite-length passkey data is not accepted.");
  switch (major) {
    case 0:
      return [length, offset];
    case 1:
      return [-1 - length, offset];
    case 2:
      need(length);
      return [buffer.subarray(offset, offset + length), offset + length];
    case 3:
      need(length);
      return [buffer.toString("utf8", offset, offset + length), offset + length];
    case 4: {
      // Every element takes at least one byte.
      if (length > buffer.length - offset) throw new Error("The passkey data ended early.");
      const list = [];
      for (let i = 0; i < length; i++) {
        let value;
        [value, offset] = cborDecode(buffer, offset, depth + 1);
        list.push(value);
      }
      return [list, offset];
    }
    case 5: {
      if (length * 2 > buffer.length - offset) throw new Error("The passkey data ended early.");
      const map = new Map();
      for (let i = 0; i < length; i++) {
        let key, value;
        [key, offset] = cborDecode(buffer, offset, depth + 1);
        if (typeof key !== "string" && typeof key !== "number") throw new Error("The passkey data has an invalid key.");
        if (map.has(key)) throw new Error("The passkey data repeats a key.");
        [value, offset] = cborDecode(buffer, offset, depth + 1);
        map.set(key, value);
      }
      return [map, offset];
    }
    case 7:
      if (info === 20) return [false, offset];
      if (info === 21) return [true, offset];
      if (info === 22) return [null, offset];
      throw new Error("The passkey data has an unsupported value.");
    default:
      throw new Error("The passkey data has an unsupported type.");
  }
}

// ---- Authenticator data ----

const FLAG_UP = 0x01; // the person was present
const FLAG_UV = 0x04; // and verified (Face ID, Touch ID or the passcode)
const FLAG_AT = 0x40; // a new credential is attached
const FLAG_ED = 0x80; // extensions follow

export function parseAuthData(data) {
  if (!Buffer.isBuffer(data) || data.length < 37) throw new Error("The passkey reply is too short.");
  const flags = data[32];
  const result = { rpIdHash: data.subarray(0, 32), flags, signCount: data.readUInt32BE(33), credential: null };
  let offset = 37;
  if (flags & FLAG_AT) {
    if (data.length < offset + 18) throw new Error("The new passkey is incomplete.");
    const idLength = data.readUInt16BE(offset + 16);
    offset += 18;
    if (idLength < 16 || idLength > 1023 || data.length < offset + idLength) throw new Error("The new passkey has an invalid id.");
    const id = data.subarray(offset, offset + idLength);
    offset += idLength;
    const [publicKey, end] = cborDecode(data, offset);
    result.credential = { id, publicKey };
    offset = end;
  }
  if (flags & FLAG_ED) {
    const [, end] = cborDecode(data, offset);
    offset = end;
  }
  if (offset !== data.length) throw new Error("The passkey reply has unexpected extra data.");
  return result;
}

/** A COSE EC2 P-256 key (algorithm -7) as a JSON Web Key. */
export function coseToJwk(key) {
  if (!(key instanceof Map)) throw new Error("The passkey's key is malformed.");
  const kty = key.get(1), alg = key.get(3), crv = key.get(-1), x = key.get(-2), y = key.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32)
    throw new Error("Palm accepts P-256 passkeys only (the kind iPhones make).");
  const jwk = { kty: "EC", crv: "P-256", x: b64u.encode(x), y: b64u.encode(y) };
  createPublicKey({ key: jwk, format: "jwk" }); // rejects a point that is not on the curve
  return jwk;
}

function checkClientData(encoded, { type, challenge, origin }) {
  const raw = b64u.decode(encoded, 8192);
  let client;
  try {
    client = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("The passkey reply is malformed.");
  }
  if (!client || client.type !== type) throw new Error("The passkey reply is for a different step.");
  if (typeof client.challenge !== "string" || client.challenge.length !== challenge.length ||
    !timingSafeEqual(Buffer.from(client.challenge), Buffer.from(challenge)))
    throw new Error("The passkey reply does not answer this request. Try again.");
  if (client.origin !== origin) throw new Error("The passkey reply came from another site.");
  if (client.crossOrigin === true) throw new Error("The passkey reply came from an embedded page.");
  return raw;
}

function checkFlags(flags, { attested }) {
  if (!(flags & FLAG_UP)) throw new Error("The passkey was used without you present.");
  if (!(flags & FLAG_UV)) throw new Error("Use Face ID, Touch ID or your passcode to confirm it's you.");
  if (attested && !(flags & FLAG_AT)) throw new Error("The passkey reply has no new key.");
}

export function newChallenge() {
  return b64u.encode(randomBytes(32));
}

/** Checks a new passkey; returns what the Mac keeps: its id, public key and counter. */
export function verifyRegistration({ credential, challenge, origin, rpId }) {
  if (!credential || credential.type !== "public-key" || typeof credential.response !== "object")
    throw new Error("The passkey reply is malformed.");
  checkClientData(credential.response.clientDataJSON, { type: "webauthn.create", challenge, origin });
  const [attestation] = cborDecode(b64u.decode(credential.response.attestationObject, 65536));
  if (!(attestation instanceof Map) || typeof attestation.get("fmt") !== "string")
    throw new Error("The passkey reply is malformed.");
  const authData = attestation.get("authData");
  const parsed = parseAuthData(authData);
  if (!parsed.rpIdHash.equals(sha256(rpId))) throw new Error("The passkey was made for another site.");
  checkFlags(parsed.flags, { attested: true });
  const id = b64u.encode(parsed.credential.id);
  if (credential.id !== id || (credential.rawId !== undefined && credential.rawId !== id))
    throw new Error("The passkey reply names a different key.");
  return { id, jwk: coseToJwk(parsed.credential.publicKey), signCount: parsed.signCount, rpId };
}

/** Checks a Face ID unlock against the kept passkey; returns its new counter. */
export function verifyAssertion({ credential, stored, challenge, origin, rpId }) {
  if (!credential || credential.type !== "public-key" || typeof credential.response !== "object")
    throw new Error("The passkey reply is malformed.");
  if (credential.id !== stored.id || (credential.rawId !== undefined && credential.rawId !== stored.id))
    throw new Error("That passkey is not the one set up for Palm on this phone.");
  if (stored.rpId !== rpId) throw new Error("This passkey was made for another address. Pair again.");
  const clientData = checkClientData(credential.response.clientDataJSON, { type: "webauthn.get", challenge, origin });
  const authData = b64u.decode(credential.response.authenticatorData, 4096);
  const parsed = parseAuthData(authData);
  if (!parsed.rpIdHash.equals(sha256(rpId))) throw new Error("The passkey was made for another site.");
  checkFlags(parsed.flags, { attested: false });
  const signature = b64u.decode(credential.response.signature, 512);
  const key = createPublicKey({ key: { ...stored.jwk, kty: "EC", crv: "P-256" }, format: "jwk" });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  if (!verify("sha256", signed, { key, dsaEncoding: "der" }, signature))
    throw new Error("The passkey's signature does not match.");
  // Synced passkeys (iCloud Keychain) always report 0; a counter that goes
  // backwards means a copied authenticator.
  if ((parsed.signCount !== 0 || stored.signCount !== 0) && parsed.signCount <= stored.signCount)
    throw new Error("This passkey's counter went backwards. Pair this phone again.");
  return { signCount: parsed.signCount };
}
