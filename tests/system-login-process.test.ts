import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { windowsLoginCloseScript } from "../src/system-login-process";

const executable = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = "C:\\private login\\owner's profile";
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

test("owned login close rejects invalid process identities before building a command", () => {
  for (const pid of [0, -1, NaN, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => windowsLoginCloseScript(pid, executable, profile)).toThrow("Invalid owned");
  }
});

// Run the real PowerShell ownership checks against inert cmdlet fixtures. No browser,
// account, window, or network request is touched by these cases.
for (const [name, command, image, window, expected] of [
  ["exact quoted argument", `"${executable}" "--user-data-dir=${profile}" --new-window`, executable, true, 0],
  ["wrong profile prefix", `"${executable}" "--user-data-dir=${profile}-neighbor"`, executable, true, 3],
  ["profile merely mentioned", `"${executable}" --user-data-dir=C:\\other "${profile}"`, executable, true, 3],
  ["foreign executable", `"--user-data-dir=${profile}"`, "C:\\foreign.exe", true, 3],
  ["no owned window", `"--user-data-dir=${profile}"`, executable, false, 4],
] as const) {
  test.skipIf(process.platform !== "win32")(`Windows normal login closes only its own window: ${name}`, () => {
    const fixture = `function Get-CimInstance { [pscustomobject]@{ExecutablePath=${quote(image)};CommandLine=${quote(command)}} }; `
      + `function Get-Process { $value=[pscustomobject]@{}; $value | Add-Member ScriptMethod CloseMainWindow { return $${window} }; return $value }; `;
    const script = fixture + windowsLoginCloseScript(123, executable, profile);
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(expected);
  });
}
