import { expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalTokenPath, loadExternalToken } from "../src/external-token";

function fixture(action: (home: string) => void) {
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  const home = mkdtempSync(join(tmpdir(), "cgw-token-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  try { action(home); } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("token generation is private and persistent; hard-linked and non-regular files fail closed", () => {
  fixture(home => {
    const secret = loadExternalToken();
    expect(loadExternalToken()).toBe(secret);
    linkSync(externalTokenPath(), join(home, "alias"));
    expect(() => loadExternalToken()).toThrow("initialization refused");
  });
});

test("redirected credential directories never create or read a token in their target", () => {
  fixture(home => {
    const target = join(home, "target");
    mkdirSync(target);
    symlinkSync(target, join(home, "external-client"), process.platform === "win32" ? "junction" : "dir");
    expect(() => loadExternalToken()).toThrow("initialization refused");
  });
});

test("existing broadly readable token files are rejected rather than trusted on EEXIST", () => {
  fixture(() => {
    loadExternalToken();
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
        $p=$env:CGW_TOKEN_TEST
        $acl=[IO.File]::GetAccessControl($p)
        $world=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($world,'Read','Allow'))
        [IO.File]::SetAccessControl($p,$acl)
      `], { env: { ...process.env, CGW_TOKEN_TEST: externalTokenPath() }, stdio: "pipe" });
    } else chmodSync(externalTokenPath(), 0o644);
    expect(() => loadExternalToken()).toThrow("initialization refused");
  });
});

test("non-regular token entry is rejected before reading", () => {
  fixture(() => {
    loadExternalToken();
    rmSync(externalTokenPath());
    mkdirSync(externalTokenPath());
    expect(() => loadExternalToken()).toThrow("initialization refused");
  });
});
