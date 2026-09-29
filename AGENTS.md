# Palm: notes for contributors and coding agents

Palm is a macOS host (a Swift launcher, a Node server, a native Swift companion, a PTY helper and a terminal service) and a native SwiftUI iPhone app. A responsive web client is kept as an alternative and serves the Mac setup page.

- Keep the server bound to loopback. Remote access is only through Tailscale Serve on the tailnet (8443 for Palm, 8444–8446 for dev-server previews). Never add Funnel or any other public exposure.
- Never log pairing secrets, session tokens, typed text, clipboard contents, file contents, terminal content or screen frames. Connection diagnostics record path, result and time only.
- Automated tests never lock, sleep, restart or shut down the real Mac, never send input to the real desktop, and never run real agents. Use the test host (`PALM_SYNTHETIC=1`): it simulates the Mac screen and every system action, uses scripted agents (`server/agents/scripted.mjs`), sends Trash to its own state folder and keeps shells in process. `scripts/ios-ui-tests.mjs` also gives it a throwaway home folder.
- The file policy lives in `server/files/fs-api.mjs` with tests in `tests/platform.test.mjs`; change both together. Removal moves items to the Trash; Palm never deletes permanently.
- Agents run the user's own binaries with their existing sign-ins. Provider API keys are stripped from agent processes. Agents get screen control only through Palm's MCP tools, and only for tasks where it is allowed; taking over from the phone revokes the agent's input lease first.
- Shells live in the terminal service (`server/terminal/daemon.mjs`, its own process group, a private socket in the state folder) so they survive Palm restarting or updating.
- Preserve macOS permission checks. Never modify TCC databases or enable permissions indirectly. "Open Palm at login" is opt-in from the phone.
- The events socket drops topics that are not in the allowlist in `handleEvent` (`server/index.mjs`). A new topic needs adding there; `tests/watch-events.test.mjs` catches a missing one.
- After editing server files, run `node --check` on them: a syntax error in `broker.mjs` makes `npm test` hang.
- UI: neutral graphite and white, Liquid Glass only for floating controls, no coloured accents, no truncation marks ("…"), titles and their buttons on one row. Keep glass and spinners out of scrolling lists.
- Demo and test state must be visibly labelled. Never show sample numbers as real measurements.
- Demo recordings: `node scripts/ios-ui-tests.mjs --demo` runs the paced walk-throughs (`testDemo*`, skipped in normal runs) against the test host in demo mode (`PALM_DEMO=1`): the simulated Mac shows `demo/mac-screens/before.png` (the demo agent swaps in `after.png` when its tests pass), agents do scripted but realistic work, the app hides its test-host label, and the Simulator's screen is recorded to `.local/ui-test-runs/<time>/demo.mp4`. Anything recorded this way is labelled as a Simulator recording wherever it is published. `demo/mac-screens/render.sh` redraws the desktop pictures from `desktop.html`.
- Before a pull request: `npm test`, `npm run build`, `npm run native:build`, `npm run test:ios-ui` and the iOS unit tests (`scripts/ios-build.sh test`).
- A claim about the physical iPhone needs evidence from a physical iPhone. Simulator and loopback results are labelled as such.
