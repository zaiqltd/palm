// Pairing, Face ID setup and unlock. The web app's version of PalmPairingView,
// plus the two Face ID steps a web pairing needs (docs/WEB-PARITY.md).
import React, { useEffect, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, CircleAlert, LockKeyhole, ScanFace, Share, ShieldCheck } from "lucide-react";
import { access, friendly, post, readAccess } from "../core/api.js";
import { setUpFaceID, unlockWithFaceID, passkeysAvailable } from "../core/passkey.js";
import { useStore } from "../core/store.js";
import { Icon, Notice, PalmMark, PrimaryButton, SecondaryButton, Spinner } from "../ui/kit.jsx";

const standalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

/** A pairing link (the Mac's QR code opens this page with #pair=CODE). */
function codeFromLink() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = (fragment.get("pair") || "").toUpperCase();
  if (fragment.has("pair")) history.replaceState(null, "", location.pathname + location.search);
  return /^[A-F0-9]{10}$/.test(code) ? code : "";
}

export function PairingView() {
  const [code, setCode] = useState(codeFromLink);
  const [name, setName] = useState("My iPhone");
  const [naming, setNaming] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState(null);
  const cleaned = code.replace(/[\s-]/g, "").toUpperCase();
  async function pair(e) {
    e?.preventDefault();
    if (pairing || cleaned.length !== 10) return;
    setError(null);
    setPairing(true);
    try {
      await post("/api/web/pair", { code: cleaned, name: (name.trim() || "My iPhone").slice(0, 50) });
      access.set({ state: "setup" });
      readAccess().catch(() => {});
    } catch (err) {
      setError(friendly(err));
    } finally {
      setPairing(false);
    }
  }
  return (
    <div className="stack-screen">
      <div className="scroll no-tabbar" style={{ paddingTop: "calc(var(--sat) + 16px)" }}>
        <form onSubmit={pair} style={{ padding: "0 20px", display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 12 }}>
            <PalmMark size={48} />
            <h1 className="t-title w-bold" style={{ margin: 0 }}>
              Pair with your Mac
            </h1>
            <p className="t-body muted" style={{ margin: 0 }}>
              On your Mac, open Palm and choose Pair an iPhone. Scan the code it shows with your iPhone’s Camera, or enter the code.
            </p>
          </div>
          {!standalone() && (
            <Notice icon={Share}>
              For the full-screen app, add Palm to your Home Screen first: tap Share, then Add to Home Screen, and pair from there.
            </Notice>
          )}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="t-subheadline w-medium">Mac address</span>
              <div className="field mono t-subheadline" style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "clip", whiteSpace: "nowrap" }} data-id="pair.host">
                {location.origin}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label className="t-subheadline w-medium" htmlFor="pair-code">
                Pairing code
              </label>
              <input
                id="pair-code"
                className="field mono t-title3"
                placeholder="10-character code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={14}
                data-id="pair.code"
              />
              <span className="t-caption muted">Codes work once and expire after two minutes.</span>
            </div>
            <div>
              <button type="button" className="t-subheadline muted" onClick={() => setNaming(!naming)} style={{ display: "flex", alignItems: "center", width: "100%", justifyContent: "space-between" }} aria-expanded={naming}>
                Name this iPhone
                <Icon as={naming ? ChevronDown : ChevronRight} size={14} weight={2.6} />
              </button>
              {naming && (
                <input className="field" style={{ marginTop: 16 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name shown on your Mac" autoComplete="nickname" maxLength={50} />
              )}
            </div>
            {error && (
              <Notice icon={CircleAlert} warning id="pair.error">
                {error}
              </Notice>
            )}
            <SecondaryButton type="submit" disabled={pairing || cleaned.length !== 10} id="pair.connect">
              {pairing && <Spinner />}
              {pairing ? "Connecting to your Mac" : "Connect to my Mac"}
              {!pairing && <Icon as={ArrowRight} size={18} />}
            </SecondaryButton>
          </div>
          <Notice icon={ShieldCheck}>
            Keep Tailscale connected on both devices. Palm is reachable only on your tailnet, and Face ID keeps this pairing yours.
          </Notice>
        </form>
      </div>
    </div>
  );
}

function FaceIDLayout({ title, text, children }) {
  return (
    <div className="stack-screen">
      <div className="scroll no-tabbar" style={{ paddingTop: "calc(var(--sat) + 16px)" }}>
        <div style={{ padding: "12px 20px 0", display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <PalmMark size={48} />
            <h1 className="t-title w-bold" style={{ margin: 0 }}>
              {title}
            </h1>
            <p className="t-body muted" style={{ margin: 0 }}>
              {text}
            </p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Right after pairing: this phone makes its passkey for Palm. */
export function FaceIDSetupView() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    passkeysAvailable().then(setAvailable);
  }, []);
  async function setUp() {
    setBusy(true);
    setError(null);
    try {
      await setUpFaceID();
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    await post("/api/disconnect", {}).catch(() => {});
    access.set({ state: "unpaired" });
  }
  return (
    <FaceIDLayout
      title="Set up Face ID"
      text="Palm on the web opens with Face ID, so this pairing works only for you. It makes a passkey for Palm on this iPhone; your face never leaves it, and your Mac checks the passkey itself."
    >
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!available && (
          <Notice warning icon={CircleAlert}>
            This browser has no Face ID passkeys. Use Safari on your iPhone, with iCloud Keychain turned on (Settings › your name › iCloud › Passwords and Keychain).
          </Notice>
        )}
        {error && (
          <Notice warning icon={CircleAlert} id="faceid.error">
            {error}
          </Notice>
        )}
        <PrimaryButton onClick={setUp} disabled={busy} id="faceid.setup">
          {busy ? <Spinner /> : <Icon as={ScanFace} size={20} />}
          {busy ? "Waiting for Face ID" : "Set up Face ID"}
        </PrimaryButton>
        <SecondaryButton onClick={cancel} disabled={busy} id="faceid.cancel">
          Cancel pairing
        </SecondaryButton>
      </div>
      <Notice icon={ShieldCheck}>Palm locks itself after ten minutes unused, and a day after you unlock it.</Notice>
    </FaceIDLayout>
  );
}

/** Opening Palm after it locked: Face ID, then the Mac unlocks it. */
export function UnlockView() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const device = useStore(access, (s) => s.name);
  async function unlock() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlockWithFaceID();
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    // Try at once; Safari may want a tap first, and then the button is there.
    const timer = setTimeout(() => unlock().catch(() => {}), 250);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="stack-screen" style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 15, maxWidth: 360 }}>
        <PalmMark size={58} />
        <div className="t-title2 w-semibold">Palm</div>
        <div className="t-subheadline muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Icon as={LockKeyhole} size={14} /> Locked{device ? ` · ${device}` : ""}
        </div>
        {error && (
          <Notice warning icon={CircleAlert} id="unlock.error">
            {error}
          </Notice>
        )}
        <div style={{ width: 280, marginTop: 8 }}>
          <PrimaryButton onClick={unlock} disabled={busy} id="unlock.faceid">
            {busy ? <Spinner /> : <Icon as={ScanFace} size={20} />}
            {busy ? "Waiting for Face ID" : "Unlock with Face ID"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
