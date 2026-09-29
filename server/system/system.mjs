import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "../platform/env.mjs";

export async function tailscaleBinary() {
  for (const candidate of [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

// Mac power, display and network state for the phone, and the actions Palm can
// honestly perform as a logged-in user process. Each capability states its
// real limits; nothing here claims a wake or startup route the Mac lacks.
export class SystemControl {
  // `synthetic` is the test host: every reading is fixed sample data and no
  // action reaches this Mac (no pmset, caffeinate or Tailscale restart).
  constructor({ native, onChange = () => {}, synthetic = false, stateDir = null }) {
    this.native = native;
    this.onChange = onChange;
    this.synthetic = synthetic;
    this.stateDir = stateDir;
    this.syntheticLoginItem = "off";
    this.sleepTimer = null; // { at: ISO time, timer }
    this.keepAwake = null; // { child, reason, since }
    this.network = { checkedAt: 0, value: null };
  }

  async power() {
    if (this.synthetic) return SAMPLE_POWER;
    const [batt, settings, custom, filevault, lid] = await Promise.all([
      run("/usr/bin/pmset", ["-g", "batt"]),
      run("/usr/bin/pmset", ["-g"]),
      run("/usr/bin/pmset", ["-g", "custom"]),
      run("/usr/bin/fdesetup", ["status"]),
      run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "4"]),
    ]);
    const source = /Now drawing from '([^']+)'/.exec(batt.stdout)?.[1] || null;
    const battery = /(\d+)%;\s*([^;]+);\s*([^\s]+)?/.exec(batt.stdout);
    const value = (text, key) => new RegExp(`\\n\\s*${key}\\s+(\\d+)`).exec(text)?.[1];
    const acBlock = custom.stdout.split("AC Power:")[1] || "";
    const batteryBlock = (custom.stdout.split("AC Power:")[0] || "").split("Battery Power:")[1] || "";
    return {
      source: source === "AC Power" ? "ac" : source === "Battery Power" ? "battery" : "unknown",
      batteryPercent: battery ? Number(battery[1]) : null,
      batteryState: battery ? battery[2].trim() : null,
      remaining: battery?.[3] && /\d+:\d+/.test(battery[3]) ? battery[3] : null,
      sleepMinutes: numberOrNull(value(settings.stdout, "sleep")),
      displaySleepMinutes: numberOrNull(value(settings.stdout, "displaysleep")),
      wakeForNetwork: { ac: value(acBlock, "womp") === "1", battery: value(batteryBlock, "womp") === "1" },
      sleepPrevented: /sleep prevented by/.test(settings.stdout),
      fileVault: /FileVault is On/.test(filevault.stdout) ? true : /FileVault is Off/.test(filevault.stdout) ? false : null,
      lidClosed: /"AppleClamshellState" = Yes/.test(lid.stdout),
    };
  }

  async status(peerAddress) {
    const [power, display, network, loginItem] = await Promise.all([
      this.power().catch(() => null),
      this.native.request({ op: "displayState" }).catch(() => null),
      this.networkPath(peerAddress).catch(() => null),
      this.loginItem().catch(() => ({ status: "unavailable" })),
    ]);
    return {
      power,
      display,
      network,
      loginItem,
      keepAwake: this.keepAwake ? { on: true, reason: this.keepAwake.reason, since: this.keepAwake.since } : { on: false },
      sleepAt: this.sleepTimer?.at ?? null,
      capabilities: this.capabilities(power),
    };
  }

  capabilities(power) {
    const fv = power?.fileVault;
    return [
      { id: "brightness", title: "Brightness", state: "supported", detail: "Built-in display brightness." },
      { id: "curtain", title: "Privacy screen", state: "supported", detail: "Blacks out the Mac's own display while your phone keeps seeing and controlling it." },
      { id: "displaySleep", title: "Display off", state: "supported", detail: "Sleeps the display now. The Mac stays awake; the next input from anywhere lights it again." },
      { id: "keepAwake", title: "Keep awake", state: "supported", detail: "Stops idle sleep while you work remotely or an agent runs. The display may still sleep." },
      { id: "lock", title: "Lock", state: "supported", detail: "Locks the Mac. Palm cannot type your password at the lock screen; unlock at the Mac or with macOS Screen Sharing." },
      {
        id: "sleep",
        title: "Sleep",
        state: "supported",
        detail: power?.wakeForNetwork?.ac
          ? "Palm becomes unreachable while the Mac sleeps. On power, Wake for network access is on; Palm's Wake button sends a Wake-on-LAN packet from your phone when both are on the same network. Tailscale alone cannot wake it."
          : "Palm becomes unreachable while the Mac sleeps. Open the lid or press a key to wake it.",
      },
      { id: "restart", title: "Restart", state: "supported", detail: (fv ? "FileVault waits for your password at the Mac first. " : "") + "Palm comes back after you log in, if Open Palm at login is on." },
      { id: "shutdown", title: "Shut down", state: "supported", detail: "Palm cannot start a Mac that is fully off." },
      {
        id: "coldStart",
        title: "Start from off",
        state: "unavailable",
        detail: fv
          ? "Needs hardware and your password: this MacBook Pro starts when its lid opens or power is connected (a smart plug could do that), but FileVault then waits for your password on the Mac before any network or Palm runs."
          : "Needs hardware: this MacBook Pro starts when its lid opens or power is connected; a smart plug on its charger could trigger that.",
      },
    ];
  }

  // Which way the paired phone reaches this Mac: a direct tailnet path or the
  // DERP relay. The relay adds large, unstable delay to video and input.
  async networkPath(peerAddress) {
    if (this.synthetic) return SAMPLE_NETWORK;
    if (this.network.value && Date.now() - this.network.checkedAt < 8000 && this.network.peer === peerAddress)
      return this.network.value;
    const tailscale = await tailscaleBinary();
    if (!tailscale) return { available: false };
    const status = await run(tailscale, ["status", "--json"], { timeout: 4000 });
    if (!status.ok) return { available: false };
    let data;
    try {
      data = JSON.parse(status.stdout);
    } catch {
      return { available: false };
    }
    const peers = Object.values(data.Peer || {});
    const phone =
      (peerAddress && peers.find((p) => (p.TailscaleIPs || []).includes(peerAddress))) ||
      peers.find((p) => p.OS === "iOS" && p.Online);
    let path = null;
    if (phone) {
      const ip = phone.TailscaleIPs?.[0];
      const ping = ip ? await run(tailscale, ["ping", "--timeout=2s", "-c", "1", ip], { timeout: 4000 }) : null;
      const match = /pong from .* via (\S+) in (\d+(?:\.\d+)?)ms/.exec(ping?.stdout || "");
      path = {
        device: phone.HostName === "localhost" ? phone.DNSName?.split(".")[0] : phone.HostName,
        direct: match ? !match[1].startsWith("DERP") : !!phone.CurAddr,
        via: match ? (match[1].startsWith("DERP") ? `relay ${phone.Relay || ""}`.trim() : "direct") : phone.CurAddr ? "direct" : `relay ${phone.Relay || ""}`.trim(),
        milliseconds: match ? Number(match[2]) : null,
      };
    }
    const value = {
      available: true,
      health: (data.Health || []).map((h) => String(h).slice(0, 200)),
      path,
      repairedAt: this.lastRepair ? new Date(this.lastRepair.at).toISOString() : null,
    };
    this.network = { checkedAt: Date.now(), value, peer: peerAddress };
    return value;
  }

  // Restarting only the Tailscale connection rebuilds its sockets. On
  // 22 September this turned a relay-only (UDP broken pipe) Mac back into
  // direct paths. The phone reconnects by itself a few seconds later.
  repairNetwork() {
    if (this.synthetic) return { ok: true, synthetic: true, detail: "Test host: nothing was restarted." };
    // watchNetwork checks afterwards that Tailscale came back on.
    this.lastRepair = { at: Date.now() };
    const child = spawn("/bin/sh", ["-c", "sleep 1; /usr/sbin/scutil --nc stop Tailscale; sleep 2; /usr/sbin/scutil --nc start Tailscale"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    this.network = { checkedAt: 0, value: null };
    return { ok: true, detail: "Tailscale is reconnecting on the Mac. Palm will reconnect in a few seconds." };
  }

  // The fault of 22 and 23 September: Tailscale's network extension stops
  // receiving UDP ("ReceiveIPv4 is not running"), so every device goes through
  // the relay and the screen and connection fall apart. Checked every minute;
  // seen twice in a row, the connection is restarted, at most every ten minutes.
  //
  // 24 September: a repair at 02:43, during one of the sleeping Mac's brief
  // wake-ups, left Tailscale stopped until it was switched on by hand after 09:50
  // (the Pi and the draw-site sync were cut off all morning). So the two
  // sightings must be a minute apart with the Mac awake, not either side of
  // a sleep, and after a repair Tailscale is switched back on if it stayed off.
  watchNetwork({
    log = () => {}, everyMs = 60000, readStatus = () => this.tailscaleStatus(), repair = () => this.repairNetwork(),
    restart = () => this.startTailscale(), now = () => Date.now(),
  } = {}) {
    if (this.synthetic || this.networkWatch) return null;
    let strikes = 0;
    let lastCheck = -Infinity;
    const check = async () => {
      const status = await readStatus();
      const at = now();
      const awake = at - lastCheck <= everyMs * 2.5;
      lastCheck = at;
      if (!status) return;
      // Palm's own repair never leaves Tailscale off. Once it is seen running,
      // switching it off is the user's choice and is left alone.
      const repaired = this.lastRepair;
      if (repaired && !repaired.confirmed) {
        if (status.state === "Running") repaired.confirmed = true;
        else if (status.state === "Stopped" && !repaired.restarted) {
          repaired.restarted = true;
          log("network.restart", { reason: "Tailscale stayed off after Palm's repair; switched back on" });
          const result = await restart();
          if (!result?.ok) log("network.restartFailed", { detail: String(result?.stderr || "").slice(0, 160) });
          return;
        }
      }
      const health = status.health;
      const relayed = health.some((h) => /ReceiveIPv[46] is not running/i.test(String(h)));
      strikes = relayed ? (awake ? strikes + 1 : 1) : 0;
      if (strikes === 1) log("network.relayOnly", { health: health.map((h) => String(h).slice(0, 120)) });
      if (strikes >= 2 && at - (this.lastRepair?.at ?? -Infinity) > 10 * 60_000) {
        strikes = 0;
        this.lastRepair = { at };
        log("network.repair", { reason: "Tailscale stopped receiving UDP; every device was relayed" });
        await repair();
      }
    };
    this.networkWatch = setInterval(() => void check().catch(() => {}), everyMs);
    this.networkWatch.unref?.();
    return check;
  }

  /** Tailscale's own state ("Running", "Stopped", ...) and its warnings. */
  async tailscaleStatus() {
    const tailscale = await tailscaleBinary();
    if (!tailscale) return null;
    const status = await run(tailscale, ["status", "--json"], { timeout: 4000 });
    try {
      const parsed = JSON.parse(status.stdout);
      return { state: String(parsed.BackendState || ""), health: Array.isArray(parsed.Health) ? parsed.Health : [] };
    } catch {
      return null;
    }
  }

  /** Switches Tailscale on (what its menu's Connect does). */
  async startTailscale() {
    if (this.synthetic) return { ok: true };
    const tailscale = await tailscaleBinary();
    if (!tailscale) return { ok: false, stderr: "Tailscale is not installed." };
    return run(tailscale, ["up"], { timeout: 20000 });
  }

  // While any agent turn runs, stop idle sleep so work continues after the
  // phone leaves. A manual keep-awake choice is left alone.
  agentActivity(count) {
    if (count > 0 && !this.keepAwake) this.setKeepAwake(true, "agents");
    else if (count === 0 && this.keepAwake?.reason === "agents") this.setKeepAwake(false);
  }

  setKeepAwake(on, reason = "manual") {
    if (this.synthetic) {
      this.keepAwake = on ? { child: null, reason, since: new Date().toISOString() } : null;
      this.onChange();
      return { on };
    }
    if (on && !this.keepAwake) {
      // -i idle sleep, -m disk sleep, -s system sleep on power. Not -d, so
      // the display can still turn off.
      const child = spawn("/usr/bin/caffeinate", ["-ims"], { stdio: "ignore" });
      child.on("exit", () => {
        if (this.keepAwake?.child === child) {
          this.keepAwake = null;
          this.onChange();
        }
      });
      this.keepAwake = { child, reason, since: new Date().toISOString() };
    } else if (!on && this.keepAwake) {
      const { child } = this.keepAwake;
      this.keepAwake = null;
      child.kill("SIGTERM");
    }
    this.onChange();
    return { on: !!this.keepAwake };
  }

  async action(name, options = {}) {
    switch (name) {
      case "brightness": {
        const value = Number(options.value);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Brightness must be between 0 and 1.");
        return this.native.request({ op: "brightness", value });
      }
      case "curtain":
        return this.native.request({ op: "curtain", on: options.on === true });
      case "keyboardLight": {
        if (typeof options.auto === "boolean") return this.native.request({ op: "keyboardLight", auto: options.auto });
        const level = Number(options.value);
        if (!Number.isFinite(level) || level < 0 || level > 1) throw new Error("Keyboard light must be between 0 and 1.");
        return this.native.request({ op: "keyboardLight", level });
      }
      case "sleepIn": {
        requireConfirm(options);
        return this.scheduleSleep(Number(options.minutes));
      }
      case "cancelSleep":
        return this.cancelSleep();
      case "displaySleep": {
        if (this.synthetic) return { ok: true, synthetic: true, detail: "Test host: no display was turned off." };
        const result = await run("/usr/bin/pmset", ["displaysleepnow"]);
        if (!result.ok) throw new Error("macOS did not accept the display sleep request.");
        return { ok: true, detail: "The Mac's display is off. Any input wakes it." };
      }
      case "keepAwake":
        return this.setKeepAwake(options.on === true);
      case "lock": {
        requireConfirm(options);
        const result = await this.native.request({ op: "lock", confirm: true });
        return { ...result, detail: this.synthetic ? "Test host: nothing was locked." : "Your Mac is locked." };
      }
      case "sleep": {
        requireConfirm(options);
        if (this.synthetic) return { ok: true, synthetic: true, detail: "Test host: nothing went to sleep." };
        // Reply first; the Mac goes to sleep a moment later.
        setTimeout(() => run("/usr/bin/pmset", ["sleepnow"]), 800).unref();
        return { ok: true, detail: "Your Mac is going to sleep. Palm will be unreachable until it wakes." };
      }
      case "restart":
      case "shutdown":
      case "logout": {
        requireConfirm(options);
        const verdict = await this.native.request({ op: "powerCheck", kind: name });
        if (!verdict?.allowed) throw new Error(verdict?.detail || "macOS did not permit Palm to do that.");
        setTimeout(() => this.native.request({ op: "power", kind: name, confirm: true }).catch(() => {}), 800).unref();
        return { ok: true, detail: name === "shutdown" ? "Your Mac is shutting down. Apps with unsaved work may ask first." : name === "restart" ? "Your Mac is restarting. Apps with unsaved work may ask first." : "Logging out." };
      }
      case "repairNetwork":
        return this.repairNetwork();
      case "loginItem":
        return this.setLoginItem(options.on === true);
      case "wakeInfo":
        return this.wakeInfo();
      default:
        throw new Error("Unsupported Mac control.");
    }
  }

  // Details the phone stores so it can send Wake-on-LAN while the Mac sleeps.
  async wakeInfo() {
    if (this.synthetic)
      return { interfaces: [{ name: "Wi-Fi", device: "en0", mac: "02:00:00:00:00:01", address: "192.0.2.10", broadcast: "192.0.2.255" }] };
    const ports = await run("/usr/sbin/networksetup", ["-listallhardwareports"]);
    const interfaces = [];
    const blocks = ports.stdout.split("\n\n");
    for (const block of blocks) {
      const name = /Hardware Port: (.+)/.exec(block)?.[1];
      const device = /Device: (\S+)/.exec(block)?.[1];
      const mac = /Ethernet Address: ([0-9a-f:]{17})/i.exec(block)?.[1];
      if (!device || !mac) continue;
      const ifconfig = await run("/sbin/ifconfig", [device]);
      const inet = /inet (\d+\.\d+\.\d+\.\d+) netmask \S+ broadcast (\d+\.\d+\.\d+\.\d+)/.exec(ifconfig.stdout);
      if (!inet) continue;
      interfaces.push({ name, device, mac, address: inet[1], broadcast: inet[2] });
    }
    return { interfaces };
  }

  // Opening Palm at login is opt-in. Only the Palm app can register itself
  // with macOS, so the server leaves a request for the launcher and reads the
  // result it reports. A development run (no launcher) reports "unavailable".
  async loginItem() {
    if (this.synthetic) return { status: this.syntheticLoginItem, synthetic: true };
    if (!this.stateDir) return { status: "unavailable" };
    try {
      const report = JSON.parse(await readFile(path.join(this.stateDir, "login-item.json"), "utf8"));
      return { status: String(report.status || "off"), error: report.error || undefined, checkedAt: report.checkedAt };
    } catch {
      return { status: "unavailable" };
    }
  }

  async setLoginItem(on) {
    if (this.synthetic) {
      this.syntheticLoginItem = on ? "enabled" : "off";
      return { ok: true, loginItem: await this.loginItem(), detail: "Test host: nothing was registered." };
    }
    const before = await this.loginItem();
    if (before.status === "unavailable") throw new Error("Only the installed Palm app can open at login.");
    await writeFile(path.join(this.stateDir, "login-item-request.json"), JSON.stringify({ enabled: on }), { mode: 0o600 });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const now = await this.loginItem();
      if (now.checkedAt && now.checkedAt !== before.checkedAt) {
        if (now.error) throw new Error(`macOS refused: ${now.error}`);
        this.onChange();
        const detail =
          now.status === "enabled"
            ? "Palm will open when you log in to the Mac."
            : now.status === "requiresApproval"
              ? "Approve Palm in System Settings › General › Login Items on the Mac."
              : "Palm will not open at login.";
        return { ok: true, loginItem: now, detail };
      }
    }
    throw new Error("Palm on the Mac did not answer. Reopen Palm and try again.");
  }

  // "Sleep in 1 hour": a timer in Palm on the Mac, kept in its state folder
  // so it survives Palm restarting. A time already past is dropped rather
  // than acted on late.
  async scheduleSleep(minutes) {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error("Choose between 1 minute and 24 hours.");
    const at = new Date(Date.now() + minutes * 60000).toISOString();
    await this.armSleep(at);
    const clock = new Date(at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
    return { ok: true, sleepAt: at, detail: `Your Mac will sleep at ${clock}.` };
  }

  async armSleep(at) {
    clearTimeout(this.sleepTimer?.timer);
    const delay = new Date(at).getTime() - Date.now();
    if (!(delay > 0)) {
      this.sleepTimer = null;
      await this.saveSleep(null);
      return;
    }
    // Checked against the wall clock at least every 30 s: Node's timers do not
    // count time the Mac spent asleep.
    const timer = setTimeout(() => (Date.now() >= new Date(at).getTime() ? this.sleepNow() : this.armSleep(at)), Math.min(delay, 30000));
    timer.unref?.();
    const changed = this.sleepTimer?.at !== at;
    this.sleepTimer = { at, timer };
    if (changed) {
      await this.saveSleep(at);
      this.onChange();
    }
  }

  async cancelSleep() {
    clearTimeout(this.sleepTimer?.timer);
    const had = !!this.sleepTimer;
    this.sleepTimer = null;
    await this.saveSleep(null);
    this.onChange();
    return { ok: true, detail: had ? "Sleep timer cancelled." : "No sleep timer was set." };
  }

  async sleepNow() {
    this.sleepTimer = null;
    await this.saveSleep(null);
    this.onChange();
    if (this.synthetic) return;
    await run("/usr/bin/pmset", ["sleepnow"]);
  }

  async saveSleep(at) {
    if (!this.stateDir) return;
    await writeFile(path.join(this.stateDir, "sleep-timer.json"), JSON.stringify({ at }), { mode: 0o600 }).catch(() => {});
  }

  /// Called once at start: re-arms a timer set before Palm restarted.
  async restoreSleep() {
    if (!this.stateDir) return;
    try {
      const { at } = JSON.parse(await readFile(path.join(this.stateDir, "sleep-timer.json"), "utf8"));
      if (at) await this.armSleep(at);
    } catch {}
  }

  stop() {
    this.setKeepAwake(false);
    clearTimeout(this.sleepTimer?.timer);
  }
}

const SAMPLE_POWER = Object.freeze({
  source: "ac",
  batteryPercent: 82,
  batteryState: "charging",
  remaining: "0:48",
  sleepMinutes: 1,
  displaySleepMinutes: 10,
  wakeForNetwork: { ac: true, battery: false },
  sleepPrevented: false,
  fileVault: true,
  lidClosed: false,
});

const SAMPLE_NETWORK = Object.freeze({
  available: true,
  health: [],
  path: { device: "test-iphone", direct: true, via: "direct", milliseconds: 4 },
});

function requireConfirm(options) {
  if (options.confirm !== true) throw new Error("Confirm this action on the phone first.");
}

function numberOrNull(value) {
  return value === undefined ? null : Number(value);
}
