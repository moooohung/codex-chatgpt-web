param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [ValidateSet('Check', 'Install', 'Rollback')][string]$Action = 'Check',
    [switch]$IdleWindowAuthorized
)

$ErrorActionPreference = 'Stop'
$planFile = (Resolve-Path -LiteralPath $PlanPath).Path
$plan = Get-Content -LiteralPath $planFile -Raw | ConvertFrom-Json
if ($plan.schemaVersion -ne 1 -or $plan.files.Count -ne 7 -or $plan.id -notmatch '^bridge-page-send-[a-z0-9-]+$') {
    throw 'Unexpected staged bridge installation plan'
}
$packageRoot = [IO.Path]::GetFullPath($plan.packageRoot)
$backupRoot = [IO.Path]::GetFullPath($plan.backupRoot)
$allowedPackageRoot = [IO.Path]::GetFullPath('C:/Users/Administrator/.codex-chatgpt-web/builds/bridge-page-send-20261007-01a1119c')
$allowedBackupRoot = [IO.Path]::GetFullPath('C:/Users/Administrator/.codex-chatgpt-web/backups/bridge-page-send-20261007-01a1119c')
if ($packageRoot -ne $allowedPackageRoot -or $backupRoot -ne $allowedBackupRoot) { throw 'Plan roots do not match the reviewed package' }
$runtimeRoots = @(
    [IO.Path]::GetFullPath('C:/Users/Administrator/.codex-chatgpt-web/versions/6.1.4-win32-x64'),
    [IO.Path]::GetFullPath('C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT/resources/runtime')
)
$archiveTarget = [IO.Path]::GetFullPath('C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT/resources/app.asar')
$allowedTargets = @($archiveTarget)
foreach ($runtimeRoot in $runtimeRoots) {
    foreach ($relativePath in @('app/cli.js', 'app/browser-helper.cjs', 'manifest.json')) {
        $allowedTargets += [IO.Path]::GetFullPath((Join-Path $runtimeRoot $relativePath))
    }
}

function FileHash([string]$LiteralPath) {
    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
function ActiveBridgeProcesses {
    $active = @()
    foreach ($process in (Get-CimInstance Win32_Process)) {
        $executable = [string]$process.ExecutablePath
        $command = [string]$process.CommandLine
        if ($process.Name -eq 'Codex Web GPT.exe' -or $executable.StartsWith('C:\Users\Administrator\AppData\Local\Programs\Codex Web GPT\', [StringComparison]::OrdinalIgnoreCase) -or
            ($command -match '(?i)\.codex-chatgpt-web[\\/]' -and $command -match '(?i)(?:\bserve\b|browser-helper|launcher[\\/]electron)')) {
            $active += [pscustomobject]@{ pid = $process.ProcessId; name = $process.Name }
        }
    }
    return $active
}
function RequireIdle {
    if (-not $IdleWindowAuthorized) { throw 'Install and Rollback require an explicitly authorized idle window (-IdleWindowAuthorized)' }
    $active = @(ActiveBridgeProcesses)
    if ($active.Count -gt 0) { throw ('Bridge processes remain active: ' + (($active.pid) -join ', ')) }
}

$records = @()
$seen = @{}
foreach ($file in $plan.files) {
    $target = [IO.Path]::GetFullPath($file.target)
    $candidate = [IO.Path]::GetFullPath($file.source)
    $backup = [IO.Path]::GetFullPath((Join-Path $backupRoot $file.backupRelativePath))
    if ($allowedTargets -notcontains $target -or $seen.ContainsKey($target)) { throw 'Plan target is not an exact reviewed file' }
    $seen[$target] = $true
    if (-not $candidate.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        -not $backup.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate or backup escapes its reviewed root' }
    if ($file.originalSha256 -notmatch '^[a-f0-9]{64}$' -or $file.candidateSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid plan hash' }
    if ((FileHash $candidate) -ne $file.candidateSha256) { throw ('Candidate hash mismatch: ' + $candidate) }
    $current = FileHash $target
    $state = if ($current -eq $file.originalSha256) { 'original' } elseif ($current -eq $file.candidateSha256) { 'candidate' } else { 'unknown' }
    $records += [pscustomobject]@{ target = $target; source = $candidate; backup = $backup; original = $file.originalSha256; candidate = $file.candidateSha256; state = $state }
}
if ($Action -eq 'Check') {
    [pscustomobject]@{ action = 'Check'; planId = $plan.id; planSha256 = FileHash $planFile; files = @($records | ForEach-Object { [pscustomobject]@{ target = $_.target; state = $_.state } }); activeProcesses = @(ActiveBridgeProcesses); writes = 0 } | ConvertTo-Json -Depth 5
    exit 0
}
RequireIdle
if (@($records | Where-Object { $_.state -eq 'unknown' }).Count -gt 0) { throw 'An installed file changed after review; do not overwrite newer work' }
if ($Action -eq 'Install') {
    if (@($records | Where-Object { $_.state -ne 'candidate' }).Count -eq 0) { Write-Output 'ALREADY_INSTALLED'; exit 0 }
    if (@($records | Where-Object { $_.state -ne 'original' }).Count -gt 0) { throw 'Mixed runtime state requires verified Rollback before Install' }
    foreach ($record in $records) {
        if (Test-Path -LiteralPath $record.backup) {
            if ((FileHash $record.backup) -ne $record.original) { throw 'Existing rollback backup differs from the original' }
        }
    }
    foreach ($record in $records) {
        if (-not (Test-Path -LiteralPath $record.backup)) {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($record.backup)) | Out-Null
            [IO.File]::Copy($record.target, $record.backup, $false)
        }
        if ((FileHash $record.backup) -ne $record.original) { throw 'Backup verification failed' }
    }
} else {
    foreach ($record in $records) {
        if (-not (Test-Path -LiteralPath $record.backup) -or (FileHash $record.backup) -ne $record.original) { throw 'Rollback needs all seven verified original backups' }
    }
}

function ReplaceReviewedFile($Record, [string]$Source, [string]$ExpectedHash, [string]$PriorHash) {
    RequireIdle
    if ((FileHash $Record.target) -ne $PriorHash -or (FileHash $Source) -ne $ExpectedHash) { throw 'File changed during installation preflight' }
    $temporary = $Record.target + '.' + $plan.id + '.tmp'
    if (Test-Path -LiteralPath $temporary) { throw 'Preserved temporary installation file already exists; inspect it first' }
    [IO.File]::Copy($Source, $temporary, $false)
    if ((FileHash $temporary) -ne $ExpectedHash) { throw 'Temporary candidate integrity failed' }
    [IO.File]::Replace($temporary, $Record.target, [NullString]::Value)
    if ((FileHash $Record.target) -ne $ExpectedHash) { throw 'Installed file integrity failed' }
}
$changed = @()
try {
    foreach ($record in $records) {
        if ($Action -eq 'Install') {
            $changed += $record
            ReplaceReviewedFile $record $record.source $record.candidate $record.original
        } elseif ($record.state -eq 'candidate') {
            $changed += $record
            ReplaceReviewedFile $record $record.backup $record.original $record.candidate
        } else { continue }
    }
    [IO.Directory]::CreateDirectory($backupRoot) | Out-Null
    $receiptPath = Join-Path $backupRoot ($Action.ToLowerInvariant() + '-receipt-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
    $receipt = [pscustomobject]@{ action = $Action; planId = $plan.id; planSha256 = FileHash $planFile; bundleId = $plan.bundleId; at = [DateTime]::UtcNow.ToString('o'); changedFiles = $changed.target; profilesChanged = $false; processesStoppedOrStarted = $false }
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 5))
    Write-Output ($Action.ToUpperInvariant() + '_VERIFIED ' + $receiptPath)
} catch {
    $failure = $_
    if ($Action -eq 'Install' -and @(ActiveBridgeProcesses).Count -eq 0) {
        foreach ($record in $changed) {
            if ((FileHash $record.target) -eq $record.candidate -and (FileHash $record.backup) -eq $record.original) {
                ReplaceReviewedFile $record $record.backup $record.original $record.candidate
            }
        }
    }
    throw $failure
}
