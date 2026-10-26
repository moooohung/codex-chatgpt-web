import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getConfigDir } from "./config";

export const externalTokenPath = () => join(getConfigDir(), "external-client", "token");

/** No redirect, device, FIFO or hard-linked token may become a bearer credential. */
function regularToken(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Invalid external token entry");
}

export function loadExternalToken(): string {
  const directory = join(getConfigDir(), "external-client");
  const path = externalTokenPath();
  // The config home itself is user-selected; the credential directory beneath it must not redirect.
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  let token: string;
  try {
    if (process.platform === "win32") {
      // Create with the protected DACL atomically, not mkdir-then-SetAcl. Existing entries are
      // validated before opening; nothing in this script follows a credential-directory reparse point.
      token = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
        $ErrorActionPreference='Stop'
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $dir=$env:CGW_EXTERNAL_AUTH_DIR
        $path=[IO.Path]::Combine($dir,'token')
        function RequirePrivate($acl) {
          if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected){throw 'Invalid credential owner or DACL'}
          $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
          if($rules.Count -eq 0){throw 'Empty credential DACL'}
          foreach($rule in $rules){
            if($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow'){throw 'Non-owner credential access'}
          }
        }
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true,$false)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
        [IO.Directory]::CreateDirectory($dir,$acl) | Out-Null
        $attributes=[IO.File]::GetAttributes($dir)
        if(($attributes -band [IO.FileAttributes]::ReparsePoint) -or -not ($attributes -band [IO.FileAttributes]::Directory)){throw 'Redirected credential directory'}
        RequirePrivate ([IO.Directory]::GetAccessControl($dir))
        if(-not [IO.File]::Exists($path)){
          $fileAcl=[Security.AccessControl.FileSecurity]::new()
          $fileAcl.SetOwner($sid)
          $fileAcl.SetAccessRuleProtection($true,$false)
          $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
          $file=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$fileAcl)
          try {
            $bytes=[byte[]]::new(32)
            $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
            try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
            $secret='cwext_'+([BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant())
            $data=[Text.Encoding]::UTF8.GetBytes($secret+[Environment]::NewLine)
            $file.Write($data,0,$data.Length)
            $file.Flush($true)
          } finally {$file.Dispose()}
        }
        $attributes=[IO.File]::GetAttributes($path)
        if(($attributes -band [IO.FileAttributes]::ReparsePoint) -or ($attributes -band [IO.FileAttributes]::Directory)){throw 'Redirected credential file'}
        RequirePrivate ([IO.File]::GetAccessControl($path))
      `], { env: { ...process.env, CGW_EXTERNAL_AUTH_DIR: directory }, stdio: "pipe" }).toString();
      regularToken(path);
      token = readFileSync(path, "utf8").trim();
    } else {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const dir = lstatSync(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid!() || (dir.mode & 0o077)) throw new Error("Invalid credential directory");
      try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, `cwext_${randomBytes(32).toString("hex")}\n`); } finally { closeSync(fd); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077)) throw new Error("Invalid credential file");
        token = readFileSync(fd, "utf8").trim();
      } finally { closeSync(fd); }
    }
    if (!/^cwext_[a-f0-9]{64}$/.test(token)) throw new Error("Invalid token format");
    return token;
  } catch {
    // Subprocess diagnostics and credential contents must never reach logs or HTTP errors.
    throw new Error("External credential initialization refused");
  }
}
