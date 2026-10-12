import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** Close only the normal browser we created, letting Windows Chrome flush its cookies. */
export function windowsLoginCloseScript(pid: number, executable: string, profile: string): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid owned login browser pid");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const argument = `--user-data-dir=${profile}`;
  return `$ErrorActionPreference='Stop'; $owned=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; `
    + `if (!$owned -or $owned.ExecutablePath -ine ${quote(executable)} `
    + `-or $owned.CommandLine -notmatch ('(?:^|\\s)(?:"' + [regex]::Escape(${quote(argument)}) + '"|' + [regex]::Escape(${quote(argument)}) + ')(?=\\s|$)')) { exit 3 }; `
    + `$window=Get-Process -Id ${pid} -ErrorAction Stop; if (!$window.CloseMainWindow()) { exit 4 }`;
}

export function requestOwnedLoginBrowserClose(browser: ChildProcess, executable: string, profile: string): void {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  if (process.platform !== "win32") {
    if (!browser.kill()) throw new Error("The dedicated Chrome login process refused to close");
    return;
  }
  const modernShell = win32.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  // The OS shell is a compatibility fallback when PowerShell 7 is not installed.
  const shell = existsSync(modernShell) ? modernShell
    : win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = windowsLoginCloseScript(browser.pid!, executable, profile);
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, stdio: "ignore", timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Could not close the dedicated Chrome login window cleanly; no session was imported");
  }
}
