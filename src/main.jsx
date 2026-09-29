// Two front ends in one page: on the Mac itself (loopback), Palm's setup page;
// everywhere else (a phone over the tailnet), the Palm app, the same as the
// iPhone app. Each loads only its own code and styles.
import React from "react";
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root"));
const params = new URLSearchParams(location.search);

async function boot() {
  let local = false;
  try {
    const response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    local = (await response.json()).local === true;
  } catch {}
  // ?phone opens the phone app on the Mac too (a preview; tests use it).
  if ((local || params.has("demo")) && !params.has("phone")) {
    const { default: SetupApp } = await import("./setup/SetupApp.jsx");
    root.render(<SetupApp />);
  } else {
    const { PhoneApp } = await import("./phone/App.jsx");
    root.render(<PhoneApp />);
  }
}

boot();
