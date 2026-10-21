param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [ValidateSet('Check', 'Prepare', 'Install', 'Rollback')][string]$Action = 'Check',
    [switch]$IdleWindowAuthorized,
    [string]$FixtureRoot,
    [switch]$FixtureFailAfterRuntime,
    [switch]$FixtureFailAfterEngine,
    [switch]$FixtureFailDuringEngine
)
$ErrorActionPreference = 'Stop'
$planFile = (Resolve-Path -LiteralPath $PlanPath).Path
$plan = Get-Content -LiteralPath $planFile -Raw | ConvertFrom-Json
$packageRoot = [IO.Path]::GetFullPath('C:/Users/Administrator/.codex-chatgpt-web/builds/bridge-6113-sendfix3-20261021')
$backupRoot = [IO.Path]::GetFullPath('C:/Users/Administrator/.codex-chatgpt-web/backups/bridge-6113-sendfix3-20261021')
$installRoot = [IO.Path]::GetFullPath('C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT')
$oldRoot = [IO.Path]::GetFullPath('C:/Users/Administrator/.codex-chatgpt-web/versions/6.1.4-win32-x64')
$preparedRuntime = Join-Path $packageRoot 'runtime-ready'
if ($FixtureRoot) {
    $expectedFixture = [IO.Path]::GetFullPath('C:/Users/Administrator/.codex-chatgpt-web/worktrees/integrate-6113-20261021/scratch/install-fixture-6113-sendfix3')
    if ([IO.Path]::GetFullPath($FixtureRoot) -ne $expectedFixture) { throw 'Fixture root is not the exact owned workspace' }
    $installRoot = Join-Path $expectedFixture 'launcher'
    $oldRoot = Join-Path $expectedFixture 'core/versions/6.1.4-win32-x64'
    $backupRoot = Join-Path $expectedFixture 'backup'
    $preparedRuntime = Join-Path $expectedFixture 'runtime-ready'
} elseif ($FixtureFailAfterRuntime -or $FixtureFailAfterEngine -or $FixtureFailDuringEngine) { throw 'Failure injection requires the isolated fixture' }
$runtimeTarget = [IO.Path]::GetFullPath((Join-Path $installRoot 'resources/runtime'))
$archiveTarget = [IO.Path]::GetFullPath((Join-Path $installRoot 'resources/app.asar'))
$sourceRuntime = Join-Path $packageRoot 'runtime-final'
$originalBackup = Join-Path $backupRoot 'resources/runtime'
$archiveBackup = Join-Path $backupRoot 'resources/app.asar'
$allowed = @($archiveTarget)
foreach ($root in @($oldRoot, $runtimeTarget)) {
    foreach ($relative in @('app/cli.js', 'app/browser-helper.cjs', 'manifest.json')) { $allowed += [IO.Path]::GetFullPath((Join-Path $root $relative)) }
}
if ($plan.schemaVersion -ne 1 -or $plan.id -ne 'bridge-6113-sendfix3-20261021' -or $plan.operation -ne 'full-launcher-upgrade' -or
    $plan.files.Count -ne 7 -or [IO.Path]::GetFullPath($plan.packageRoot) -ne $packageRoot -or
    [IO.Path]::GetFullPath($plan.backupRoot) -ne $backupRoot -or
    [IO.Path]::GetFullPath($plan.runtimeBundle.target) -ne $runtimeTarget -or
    [IO.Path]::GetFullPath($plan.runtimeBundle.source) -ne $sourceRuntime -or
    $plan.runtimeBundle.version -ne '6.1.13') { throw 'Plan differs from reviewed integrated release' }
function FileHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function RequireInside([string]$Path, [string]$Root) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'File escapes reviewed root' }
    return $resolved
}
function BridgeProcesses {
    if ($FixtureRoot) { return @() }
    $found = @()
    foreach ($p in (Get-CimInstance Win32_Process)) {
        $command = ([string]$p.CommandLine).Replace('/', '\')
        if (([string]$p.ExecutablePath).StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
            ($command -match '(?i)\.codex-chatgpt-web[\\/]' -and $command -match '(?i)(?:\bserve\b|browser-helper|launcher[\\/]electron)')) {
            $found += [pscustomobject]@{ pid = $p.ProcessId; name = $p.Name }
        }
    }
    return $found
}
function RequireIdle {
    if (-not $IdleWindowAuthorized -or @(BridgeProcesses).Count -ne 0) { throw 'Full replacement requires the authorized, settled bridge window' }
}
function CopyReviewedTree([string]$Source, [string]$Destination) {
    $sourcePath = [IO.Path]::GetFullPath($Source)
    $destinationPath = [IO.Path]::GetFullPath($Destination)
    if ($sourcePath -notin @($sourceRuntime, $runtimeTarget, $originalBackup)) { throw 'Unreviewed recursive copy source' }
    if ($destinationPath -notin @($originalBackup, $preparedRuntime) -and $destinationPath -notmatch ('^' + [regex]::Escape($runtimeTarget + '.' + $plan.id + '.incoming-') + '[a-f0-9]{32}$')) { throw 'Unreviewed recursive copy destination' }
    $output = & 'C:/Windows/System32/robocopy.exe' $sourcePath $destinationPath /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:2 /XJ /NFL /NDL /NJH /NJS /NP 2>&1
    if ($LASTEXITCODE -ge 8) { throw ('Reviewed copy failed: ' + ($output -join ' ')) }
}
$validator = RequireInside $plan.validationScript.path $packageRoot
if ((FileHash $validator) -ne $plan.validationScript.sha256 -or (FileHash (Join-Path $sourceRuntime 'manifest.json')) -ne $plan.runtimeBundle.manifestSha256) { throw 'Candidate validation inputs changed' }
$validationExecutable = [IO.Path]::GetFullPath($plan.validationExecutable.path)
if ($validationExecutable -ne 'C:\Program Files\nodejs\node.exe' -or (FileHash $validationExecutable) -ne $plan.validationExecutable.sha256) { throw 'Reviewed validation executable changed' }
function VerifyBundle([string]$Root, [string]$Version, [string]$BundleId) {
    $output = & $validationExecutable $validator $planFile $Root $Version $BundleId 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('Full runtime verification failed: ' + ($output -join ' ')) }
    return ($output -join '') | ConvertFrom-Json
}
$candidateProof = VerifyBundle $sourceRuntime '6.1.13' $plan.bundleId
if ($candidateProof.filesVerified -ne $plan.runtimeBundle.fileCount) { throw 'Candidate file count differs' }
$records = @()
foreach ($file in $plan.files) {
    $target = [IO.Path]::GetFullPath($file.target)
    if ($target -notin $allowed) { throw 'Unknown or duplicate watch target' }
    $allowed = @($allowed.Where({ $_ -ne $target }))
    $source = RequireInside $file.source $packageRoot
    if ($file.originalSha256 -notmatch '^[a-f0-9]{64}$' -or $file.candidateSha256 -notmatch '^[a-f0-9]{64}$' -or
        (FileHash $source) -ne $file.candidateSha256) { throw 'Reviewed watch hash differs' }
    $current = FileHash $target
    if ($current -ne $file.originalSha256 -and $current -ne $file.candidateSha256) { throw 'Installed watch file changed after review' }
    $records += [pscustomobject]@{ target = $target; source = $source; original = $file.originalSha256; candidate = $file.candidateSha256; current = $current }
}
foreach ($dependency in $plan.readOnlyDependencies) {
    if ([IO.Path]::GetFullPath($dependency.target) -ne [IO.Path]::GetFullPath($archiveTarget + '.unpacked/assets/linux-appimage-runner.sh') -or
        (FileHash $dependency.target) -ne $dependency.sha256) { throw 'Unpacked dependency changed' }
}

$engineRecords = @()
$engineTargets = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $plan.launcherFiles) {
    $target = RequireInside $file.target $installRoot
    $source = RequireInside $file.source $packageRoot
    if (-not $engineTargets.Add($target) -or $target -eq $archiveTarget -or $target.StartsWith($runtimeTarget + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid engine target' }
    $relative = [IO.Path]::GetRelativePath($installRoot, $target)
    if (($null -ne $file.originalSha256 -and $file.originalSha256 -notmatch '^[a-f0-9]{64}$') -or $file.candidateSha256 -notmatch '^[a-f0-9]{64}$' -or
        (FileHash $source) -ne $file.candidateSha256 -or (Test-Path -LiteralPath $target -PathType Container)) { throw 'Reviewed engine identity differs' }
    $current = if (Test-Path -LiteralPath $target) { FileHash $target } else { $null }
    if ($current -ne $file.originalSha256 -and $current -ne $file.candidateSha256) { throw 'Unreviewed installed engine' }
    $engineRecords += [pscustomobject]@{ target = $target; source = $source; original = $file.originalSha256; candidate = $file.candidateSha256; current = $current; backup = Join-Path $backupRoot ('engine/' + $relative) }
}
$engineExe = @($engineRecords | Where-Object { $_.target -eq (Join-Path $installRoot 'Codex Web GPT.exe') })
if ($engineExe.Count -ne 1 -or -not $engineExe[0].original) { throw 'Reviewed original and candidate engine executable required' }
$archiveRecord = $records.Where({ $_.target -eq $archiveTarget })[0]
$manifestHash = FileHash (Join-Path $runtimeTarget 'manifest.json')
$installedVersion = if ($manifestHash -eq $plan.runtimeBundle.manifestSha256 -and
    (FileHash $archiveTarget) -eq $archiveRecord.candidate) { 'candidate' }
    elseif ($manifestHash -eq $plan.runtimeBundle.originalManifestSha256) { 'original' }
    elseif ($manifestHash -eq $plan.runtimeBundle.manifestSha256) { 'candidate' } else { throw 'Unknown installed manifest' }
$installedProof = if ($installedVersion -eq 'original') { VerifyBundle $runtimeTarget $plan.runtimeBundle.originalVersion $plan.runtimeBundle.originalBundleId }
    else { VerifyBundle $runtimeTarget '6.1.13' $plan.bundleId }
if ($Action -eq 'Check') {
    [pscustomobject]@{ action = 'Check'; installed = $installedProof; candidate = $candidateProof; watchFiles = $records.Count; engineFiles = $engineRecords.Count; activeProcesses = @(BridgeProcesses); writes = 0 } | ConvertTo-Json -Depth 5
    exit 0
}
function EnsureOriginalBackup {
    if ($installedVersion -ne 'original' -or (FileHash $archiveTarget) -ne $archiveRecord.original) { throw 'Original backup requires a complete original installation' }
    if (-not (Test-Path -LiteralPath $originalBackup)) {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($originalBackup)) | Out-Null
        CopyReviewedTree $runtimeTarget $originalBackup
    }
    VerifyBundle $originalBackup $plan.runtimeBundle.originalVersion $plan.runtimeBundle.originalBundleId | Out-Null
    if (-not (Test-Path -LiteralPath $archiveBackup)) { [IO.File]::Copy($archiveTarget, $archiveBackup, $false) }
    if ((FileHash $archiveBackup) -ne $archiveRecord.original) { throw 'Original archive backup differs' }
    foreach ($record in $engineRecords) {
        if ($record.current -ne $record.original) { throw 'Original engine changed before backup' }
        if ($record.original) {
            if (-not (Test-Path -LiteralPath $record.backup)) {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($record.backup)) | Out-Null
                [IO.File]::Copy($record.target, $record.backup, $false)
            }
            if ((FileHash $record.backup) -ne $record.original) { throw 'Original engine backup differs' }
        }
    }
}
if ($Action -eq 'Prepare') {
    EnsureOriginalBackup
    if (-not (Test-Path -LiteralPath $preparedRuntime)) { CopyReviewedTree $sourceRuntime $preparedRuntime }
    VerifyBundle $preparedRuntime '6.1.13' $plan.bundleId | Out-Null
    foreach ($record in $records) { if ((FileHash $record.target) -ne $record.original) { throw 'Installed files changed during preparation' } }
    [pscustomobject]@{ action = 'Prepare'; at = [DateTime]::UtcNow.ToString('o'); originalBackup = $originalBackup; preparedRuntime = $preparedRuntime;
        preparedBundleId = $plan.bundleId; filesVerified = $plan.runtimeBundle.fileCount; liveFilesChanged = 0; processesStoppedOrStarted = $false } | ConvertTo-Json
    exit 0
}
RequireIdle
function ReplaceArchive([string]$Source, [string]$Expected, [string]$Prior) {
    RequireIdle
    if ((FileHash $archiveTarget) -ne $Prior -or (FileHash $Source) -ne $Expected) { throw 'Archive changed during transaction' }
    $temporary = $archiveTarget + '.' + $plan.id + '.tmp'
    if (Test-Path -LiteralPath $temporary) { throw 'Preserve existing archive transaction' }
    [IO.File]::Copy($Source, $temporary, $false)
    if ((FileHash $temporary) -ne $Expected) { throw 'Temporary archive integrity failed' }
    [IO.File]::Replace($temporary, $archiveTarget, [NullString]::Value)
    if ((FileHash $archiveTarget) -ne $Expected) { throw 'Installed archive integrity failed' }
}
function SwitchRuntime([string]$Source, [string]$Version, [string]$BundleId) {
    RequireIdle
    # Every recursive copy and directory move has a resolved, exact reviewed target.
    if ($Source -eq $sourceRuntime -and (Test-Path -LiteralPath $preparedRuntime)) {
        $incoming = [IO.Path]::GetFullPath($preparedRuntime)
        if ($incoming -ne [IO.Path]::GetFullPath($preparedRuntime)) { throw 'Prepared runtime source differs' }
    } else {
        $incoming = [IO.Path]::GetFullPath($runtimeTarget + '.' + $plan.id + '.incoming-' + [Guid]::NewGuid().ToString('N'))
        if ([IO.Path]::GetDirectoryName($incoming) -ne [IO.Path]::GetDirectoryName($runtimeTarget) -or
            $incoming -notmatch ('^' + [regex]::Escape($runtimeTarget + '.' + $plan.id + '.incoming-') + '[a-f0-9]{32}$') -or
            (Test-Path -LiteralPath $incoming)) { throw 'Runtime staging directory is not exact and fresh' }
        CopyReviewedTree $Source $incoming
    }
    VerifyBundle $incoming $Version $BundleId | Out-Null
    $displaced = Join-Path $backupRoot ('displaced/runtime-' + [Guid]::NewGuid().ToString('N'))
    $displaced = RequireInside $displaced $backupRoot
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($displaced)) | Out-Null
    RequireIdle
    [IO.Directory]::Move($runtimeTarget, $displaced)
    try { [IO.Directory]::Move($incoming, $runtimeTarget) }
    catch { if (-not (Test-Path -LiteralPath $runtimeTarget)) { [IO.Directory]::Move($displaced, $runtimeTarget) }; throw }
    VerifyBundle $runtimeTarget $Version $BundleId | Out-Null
}
function ReplaceEngine($Record, [string]$Source, [string]$Expected, $Prior) {
    RequireIdle
    $current = if (Test-Path -LiteralPath $Record.target) { FileHash $Record.target } else { $null }
    if ($current -ne $Prior -or (FileHash $Source) -ne $Expected) { throw 'Engine changed during transaction' }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Record.target)) | Out-Null
    $temporary = $Record.target + '.' + $plan.id + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::Copy($Source, $temporary, $false)
    if ((FileHash $temporary) -ne $Expected) { throw 'Temporary engine hash differs' }
    if ($null -eq $Prior) { [IO.File]::Move($temporary, $Record.target) }
    else { [IO.File]::Replace($temporary, $Record.target, [NullString]::Value) }
    if ((FileHash $Record.target) -ne $Expected) { throw 'Installed engine verification failed' }
}
function RestoreOriginal {
    RequireIdle
    foreach ($record in $engineRecords) {
        $current = if (Test-Path -LiteralPath $record.target) { FileHash $record.target } else { $null }
        if ($current -eq $record.original) { continue }
        if ($current -ne $record.candidate) { throw 'Unknown engine cannot be overwritten during rollback' }
        if ($record.original) { ReplaceEngine $record $record.backup $record.original $record.candidate }
        else { $exact = RequireInside $record.target $installRoot; Remove-Item -LiteralPath $exact -Force }
    }
    if ((FileHash (Join-Path $originalBackup 'manifest.json')) -ne $plan.runtimeBundle.originalManifestSha256 -or
        (FileHash $archiveBackup) -ne $archiveRecord.original) { throw 'Original backup integrity differs' }
    VerifyBundle $originalBackup $plan.runtimeBundle.originalVersion $plan.runtimeBundle.originalBundleId | Out-Null
    $current = FileHash (Join-Path $runtimeTarget 'manifest.json')
    if ($current -eq $plan.runtimeBundle.manifestSha256) { SwitchRuntime $originalBackup $plan.runtimeBundle.originalVersion $plan.runtimeBundle.originalBundleId }
    elseif ($current -ne $plan.runtimeBundle.originalManifestSha256) { throw 'Unknown runtime cannot be overwritten during rollback' }
    $current = FileHash $archiveTarget
    if ($current -eq $archiveRecord.candidate) { ReplaceArchive $archiveBackup $archiveRecord.original $archiveRecord.candidate }
    elseif ($current -ne $archiveRecord.original) { throw 'Unknown launcher cannot be overwritten during rollback' }
}
if ($Action -eq 'Install') {
    if ($installedVersion -eq 'candidate' -and (FileHash $archiveTarget) -eq $archiveRecord.candidate -and @($engineRecords | Where-Object { $_.current -ne $_.candidate }).Count -eq 0) { Write-Output 'ALREADY_INSTALLED_VERIFIED'; exit 0 }
    if ($installedVersion -ne 'original' -or (FileHash $archiveTarget) -ne $archiveRecord.original) { throw 'Mixed installation requires rollback first' }
    EnsureOriginalBackup
    try {
        if ((FileHash (Join-Path $runtimeTarget 'manifest.json')) -ne $plan.runtimeBundle.originalManifestSha256) { throw 'Runtime changed before swap' }
        SwitchRuntime $sourceRuntime '6.1.13' $plan.bundleId
        if ($FixtureFailAfterRuntime) { throw 'Injected fixture failure after full runtime swap' }
        ReplaceArchive $archiveRecord.source $archiveRecord.candidate $archiveRecord.original
        $engineSwaps = 0
        foreach ($record in $engineRecords) {
            if ($record.original -ne $record.candidate) {
                ReplaceEngine $record $record.source $record.candidate $record.original
                $engineSwaps++
                if ($FixtureFailDuringEngine -and $engineSwaps -eq 3) { throw "Injected fixture failure during partial engine swap" }
            }
        }
        if ($FixtureFailAfterEngine) { throw 'Injected fixture failure after engine swap' }
    } catch { $failure = $_; RestoreOriginal; throw $failure }
} else { RestoreOriginal }
$version = if ($Action -eq 'Install') { '6.1.13' } else { $plan.runtimeBundle.originalVersion }
$bundleId = if ($Action -eq 'Install') { $plan.bundleId } else { $plan.runtimeBundle.originalBundleId }
foreach ($record in $engineRecords) {
    $expected = if ($Action -eq 'Install') { $record.candidate } else { $record.original }
    $actual = if (Test-Path -LiteralPath $record.target) { FileHash $record.target } else { $null }
    if ($actual -ne $expected) { throw 'Final engine verification failed' }
}
$proof = VerifyBundle $runtimeTarget $version $bundleId
$receipt = [ordered]@{ action = $Action; planId = $plan.id; planSha256 = FileHash $planFile; at = [DateTime]::UtcNow.ToString('o'); runtime = $proof;
    archiveSha256 = FileHash $archiveTarget; engineFilesVerified = $engineRecords.Count; electronVersion = $plan.electronVersion; oldVersionPreserved = $true; profilesChanged = $false; processesStoppedOrStarted = $false; fixture = [bool]$FixtureRoot }
$receiptPath = Join-Path $backupRoot ($Action.ToLowerInvariant() + '-receipt-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 6))
Write-Output ($Action.ToUpperInvariant() + '_VERIFIED ' + $receiptPath)
