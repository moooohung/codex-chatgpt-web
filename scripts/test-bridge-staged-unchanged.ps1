param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('bridge-unchanged-fixture-' + [Guid]::NewGuid().ToString('N'))))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$packageRoot = Join-Path $fixtureRoot 'package'
$backupRoot = Join-Path $fixtureRoot 'backups'
$runtimeRoots = @((Join-Path $fixtureRoot 'runtime-1'), (Join-Path $fixtureRoot 'runtime-2'))
$archive = Join-Path $fixtureRoot 'app.asar'
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function ReplaceOnce([string]$Text, [string]$Needle, [string]$Value) {
    if ($Text.Split(@($Needle), [StringSplitOptions]::None).Count -ne 2) { throw 'Fixture source anchor changed' }
    return $Text.Replace($Needle, $Value)
}
$source = Get-Content -LiteralPath $InstallerPath -Raw
$source = ReplaceOnce $source "C:/Users/Administrator/.codex-chatgpt-web/builds/bridge-page-send-20261007-01a1119c" $packageRoot
$source = ReplaceOnce $source "C:/Users/Administrator/.codex-chatgpt-web/backups/bridge-page-send-20261007-01a1119c" $backupRoot
$source = ReplaceOnce $source "C:/Users/Administrator/.codex-chatgpt-web/versions/6.1.4-win32-x64" $runtimeRoots[0]
$source = ReplaceOnce $source "C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT/resources/runtime" $runtimeRoots[1]
$source = ReplaceOnce $source "C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT/resources/app.asar" $archive
# Only the OS ownership query is replaced. All plan/hash/state and real NTFS
# replacement/backup/rollback behavior runs from the actual installer source.
$pattern = '(?s)function ActiveBridgeProcesses \{.*?\r?\n}\r?\nfunction RequireIdle'
if ([regex]::Matches($source, $pattern).Count -ne 1) { throw 'Fixture process query anchor changed' }
$source = [regex]::Replace($source, $pattern, "function ActiveBridgeProcesses { return @() }`nfunction RequireIdle")
$installer = Join-Path $fixtureRoot 'installer.ps1'
[IO.File]::WriteAllText($installer, $source)
$files = @()
for ($i = 0; $i -lt 2; $i++) {
    foreach ($relative in @('app/cli.js', 'app/browser-helper.cjs', 'manifest.json')) {
        $target = Join-Path $runtimeRoots[$i] $relative
        $candidate = Join-Path $packageRoot $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($candidate)) | Out-Null
        [IO.File]::WriteAllText($target, 'original-' + $relative)
        [IO.File]::WriteAllText($candidate, 'candidate-' + $relative)
        $files += @{ target = $target; source = $candidate; backupRelativePath = 'runtime-' + ($i + 1) + '/' + $relative; originalSha256 = Hash $target; candidateSha256 = Hash $candidate }
    }
}
$archiveSource = Join-Path $packageRoot 'app.asar'
[IO.File]::WriteAllText($archive, 'preserved archive')
[IO.File]::WriteAllText($archiveSource, 'preserved archive')
$archiveWriteTime = [IO.File]::GetLastWriteTimeUtc($archive)
$files += @{ target = $archive; source = $archiveSource; backupRelativePath = 'launcher/app.asar'; originalSha256 = Hash $archive; candidateSha256 = Hash $archiveSource }
$planPath = Join-Path $fixtureRoot 'plan.json'
$plan = @{ schemaVersion = 1; id = 'bridge-page-send-unchanged-fixture'; packageRoot = $packageRoot; backupRoot = $backupRoot; bundleId = 'fixture'; files = $files }
[IO.File]::WriteAllText($planPath, ($plan | ConvertTo-Json -Depth 5))
$shell = (Get-Process -Id $PID).Path
function RunInstaller([string]$Action, [bool]$Authorize = $true) {
    $arguments = @('-NoProfile', '-File', $installer, '-PlanPath', $planPath, '-Action', $Action)
    if ($Authorize) { $arguments += '-IdleWindowAuthorized' }
    $output = & $shell @arguments 2>&1
    return @{ code = $LASTEXITCODE; output = [string]::Join("`n", $output) }
}
$guard = RunInstaller 'Install' $false
if ($guard.code -eq 0) { throw 'Missing idle authorization was accepted' }
foreach ($file in $files) { if ((Hash $file.target) -ne $file.originalSha256) { throw 'Authorization guard wrote a target' } }
$install = RunInstaller 'Install'
if ($install.code -ne 0 -or $install.output -notmatch 'INSTALL_VERIFIED') { throw ('Fixture install failed: ' + $install.output) }
foreach ($file in $files) {
    if ((Hash $file.target) -ne $file.candidateSha256 -or (Hash (Join-Path $backupRoot $file.backupRelativePath)) -ne $file.originalSha256) { throw 'Candidate or original backup differs' }
}
$receipts = @(Get-ChildItem -LiteralPath $backupRoot -Filter 'install-receipt-*.json')
$receipt = Get-Content -LiteralPath $receipts[0].FullName -Raw | ConvertFrom-Json
if ($receipt.changedFiles.Count -ne 6 -or [IO.File]::GetLastWriteTimeUtc($archive) -ne $archiveWriteTime) { throw 'Unchanged archive was replaced' }
$repeat = RunInstaller 'Install'
if ($repeat.code -ne 0 -or $repeat.output -notmatch 'ALREADY_INSTALLED' -or @(Get-ChildItem -LiteralPath $backupRoot -Filter 'install-receipt-*.json').Count -ne 1) { throw 'Repeated install was not a no-op' }
[IO.File]::WriteAllText($files[0].target, 'newer unknown work')
$unknown = RunInstaller 'Rollback'
if ($unknown.code -eq 0 -or $unknown.output -notmatch 'do not overwrite newer work' -or [IO.File]::ReadAllText($files[0].target) -ne 'newer unknown work') { throw 'Unknown hash guard failed' }
[IO.File]::WriteAllText($files[0].target, 'candidate-app/cli.js')
[IO.File]::Copy((Join-Path $backupRoot $files[0].backupRelativePath), $files[0].target, $true)
$mixed = RunInstaller 'Install'
if ($mixed.code -eq 0 -or $mixed.output -notmatch 'Mixed runtime state') { throw 'Mixed runtime guard failed' }
$rollback = RunInstaller 'Rollback'
if ($rollback.code -ne 0 -or $rollback.output -notmatch 'ROLLBACK_VERIFIED') { throw ('Fixture rollback failed: ' + $rollback.output) }
foreach ($file in $files) { if ((Hash $file.target) -ne $file.originalSha256) { throw 'Rollback differs from original' } }
if ([IO.File]::GetLastWriteTimeUtc($archive) -ne $archiveWriteTime) { throw 'Rollback replaced unchanged archive' }
[pscustomobject]@{ install = 'pass'; unchangedArchive = 'pass'; repeatedInstall = 'pass'; rollback = 'pass'; unknownHashGuard = 'pass'; mixedStateGuard = 'pass'; authorizationGuard = 'pass'; realInstalledFilesTouched = 0; changedFiles = 6; verifiedBackups = 7; fixtureRoot = $fixtureRoot; installerSha256 = Hash $InstallerPath } | ConvertTo-Json
