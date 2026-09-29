# Third-party software

Palm uses the following. Each keeps its own licence.

| Component | Used for | Licence | How it arrives |
|---|---|---|---|
| [WebRTC](https://webrtc.org), prebuilt by [stasel/WebRTC](https://github.com/stasel/WebRTC) (M153) | Camera and mic audio: Opus, echo cancellation, jitter buffer | BSD 3-Clause (Google) | Downloaded at build time by `scripts/fetch-webrtc.sh`, checked by SHA-256; not in this repository. Its licence ships inside the framework. |
| [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) 1.20.0 | The iPhone terminal | MIT | Swift Package Manager |
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/headless`, `@xterm/addon-serialize`) | Terminal state on the Mac | MIT | npm; licence in `licenses/xterm.js-LICENSE` |
| [React](https://react.dev) | The Mac setup page and web client | MIT | npm |
| [Lucide](https://lucide.dev) (`lucide-react`) | Icons in the web client | ISC | npm |
| [node-qrcode](https://github.com/soldair/node-qrcode) | The pairing QR code | MIT | npm |
| [ws](https://github.com/websockets/ws) | WebSockets on the Mac host | MIT | npm |

Claude Code, Codex and the other agents Palm talks to are not included. Palm runs the copies installed on your Mac, under their own terms and your own sign-ins.
