import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

test("real PCM conversion and offline speaker rendering preserve audible samples and bound latency", () => {
  mkdirSync(".local/audio-tests", { recursive: true });
  execFileSync("/usr/bin/swiftc", ["-swift-version", "5", "-O", "-parse-as-library",
    "shared/PalmRealtimeAudio.swift", "tests/PalmRealtimeAudioTests.swift", "-framework", "AVFoundation",
    "-framework", "CoreMedia", "-o", ".local/audio-tests/check"], { timeout: 60_000 });
  const report = JSON.parse(execFileSync(".local/audio-tests/check", [], { encoding: "utf8", timeout: 20_000 }));
  assert.equal(report.passed, true);
  assert.ok(report.playback.nonzeroRenderedFrames > 20_000);
  assert.ok(report.congested.queuedMs <= 400);
});
