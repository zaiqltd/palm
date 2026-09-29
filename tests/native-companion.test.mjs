import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Native } from "../server/native.mjs";

test("uncertain companion command timeout fails closed and EOF releases the child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palm-companion-timeout-"));
  const executable = path.join(
    root,
    "build/Palm Companion.app/Contents/MacOS/PalmCompanion",
  );
  const marker = path.join(root, "released.txt");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'released'); process.exit(0); });
process.stdout.write('ready\\n');
`,
    { mode: 0o700 },
  );
  const native = new Native(root, { requestTimeout: 50 });
  try {
    await once(native.child.stdout, "data");
    const first = native.request({ op: "status" });
    const second = native.request({ op: "apps" });
    await Promise.all([
      assert.rejects(first, /Restart Palm/),
      assert.rejects(second, /Restart Palm/),
    ]);
    assert.equal(native.dead, true);
    assert.equal(native.pending.size, 0);
    await assert.rejects(native.request({ op: "start" }), /unavailable/);
    await native.close();
    assert.equal(await readFile(marker, "utf8"), "released");
    assert.equal(native.child.exitCode, 0);
  } finally {
    await native.close();
  }
});
