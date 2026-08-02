import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { ProcessRunner } from "../processRunner.js";
import { asCliExecutable } from "../types.js";

test("process runner executes a native binary without a shell", async () => {
  const result = await new ProcessRunner().run(
    asCliExecutable(process.execPath),
    ["-e", "process.stdout.write('RUNNER_OK')"],
    { cwd: process.cwd(), timeoutMs: 10_000 }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "RUNNER_OK");
});

test(
  "process runner executes Windows cmd shims with quoted arguments",
  { skip: process.platform !== "win32" },
  async () => {
    const executable = path.join(process.cwd(), "node_modules", ".bin", "vsce.cmd");
    const result = await new ProcessRunner().run(
      asCliExecutable(executable),
      ["--version"],
      { cwd: process.cwd(), timeoutMs: 10_000 }
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/u);
  }
);
