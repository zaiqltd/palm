# Security

Palm gives a paired phone (the iPhone app, or a phone's browser) control of your Mac: its screen, its files, its shells and the agents that run on it. Treat a paired phone like a second keyboard on your desk. This page says what protects that link and what does not.

## What a paired phone can do

- See the whole screen and send mouse and keyboard input (macOS Screen Recording and Accessibility permissions).
- Read, upload and download any file your macOS account can reach, including hidden folders.
- Open shells as your user.
- Start agents (Claude Code, Codex, ACP agents) in any folder, with the access chosen for that task. Sessions the Assistant starts run with full access: Claude Code's `bypassPermissions`, Codex's equivalent. Your own agent settings can grant more.
- Lock, sleep, restart or shut down the Mac, and turn on its camera and microphone while Camera and mic is open.

## What protects it

- **No public exposure.** The host listens on `127.0.0.1:4318` only. Remote access goes through Tailscale Serve, which reaches devices on your tailnet and nothing else. Do not use Tailscale Funnel with Palm.
- **Pairing.** A pairing code is single-use and expires after two minutes. A pairing lasts 30 days. The Mac keeps only a SHA-256 hash of each token; the iPhone app keeps its token in the Keychain. Revoke a phone from the Mac's setup page at any time.
- **Browsers need Face ID.** A browser's pairing is an HttpOnly, SameSite=Strict cookie that scripts cannot read, and it opens nothing until the phone sets up a passkey (Face ID or a fingerprint). The Mac verifies the passkey itself on every unlock: the address, user verification and a one-time challenge. A browser locks after 10 idle minutes and once a day. Only the Mac itself can pair a browser without a passkey.
- **Credential stores.** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.credentials`, macOS keychains and the Claude and Codex auth files need a confirmation on the phone for every request before any content leaves the Mac. Palm's own state folder is blocked outright.
- **Nothing is deleted.** Removing a file from the phone moves it to the Trash.
- **Previews.** Dev-server previews open through single-use tickets and an HttpOnly cookie per preview port. Other requests get 401.
- **Screen hand-off.** An agent can use the screen only for tasks where you allowed it. Taking over from the phone revokes the agent's input before any of yours is accepted.
- **Logs.** Palm never logs pairing secrets, session tokens, typed text, clipboard contents, file contents, terminal content or screen frames. Its logs record path, result and time.
- **Agent billing.** Provider API keys in your shell are stripped from agent processes, so an agent uses its own sign-in and cannot switch to paid API billing without you.
- **Voice.** Your OpenRouter key stays on the Mac in a file only your account can read, and never goes to the phone. Recorded audio is sent to OpenRouter to be transcribed and is not kept.

## What it does not protect against

- Anyone who has your unlocked, paired phone (and, for a browser, can pass its Face ID).
- Other devices on your tailnet that you do not trust. They cannot pair without a code shown on the Mac, but they can reach the port. Tailscale ACLs can restrict which devices reach port 8443.
- Agents you have allowed to act. An agent with full access can do anything your user can.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository, or email hello@zaiq.ai. Do not open a public issue for a security problem.
