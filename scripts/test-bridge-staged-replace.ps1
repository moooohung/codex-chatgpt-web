param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $InstallerPath -Raw
$match = [regex]::Match($source, '(?s)function ReplaceReviewedFile\(.*?\r?\n}\r?\n\$changed =')
if (-not $match.Success) { throw 'Reviewed replacement function not found' }
$functionText = $match.Value.Substring(0, $match.Value.LastIndexOf('$changed ='))
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('bridge-replace-fixture-' + [Guid]::NewGuid().ToString('N'))))
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $fixtureRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture root' }
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
function FileHash([string]$LiteralPath) { return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant() }
function RequireIdle { if (-not $fixtureIdle) { throw 'Fixture is not idle' } }
$fixtureIdle = $true
$plan = @{ id = 'fixture' }
$target = Join-Path $fixtureRoot 'target.txt'
$candidate = Join-Path $fixtureRoot 'candidate.txt'
$backup = Join-Path $fixtureRoot 'original.txt'
try {
    [IO.File]::WriteAllText($target, 'original')
    [IO.File]::WriteAllText($backup, 'original')
    [IO.File]::WriteAllText($candidate, 'candidate')
    $originalHash = FileHash $target
    $candidateHash = FileHash $candidate
    $record = @{ target = $target }
    . ([scriptblock]::Create($functionText))
    ReplaceReviewedFile $record $candidate $candidateHash $originalHash
    if ((FileHash $target) -ne $candidateHash -or (FileHash $backup) -ne $originalHash) { throw 'Replacement or original backup integrity failed' }
    ReplaceReviewedFile $record $backup $originalHash $candidateHash
    if ((FileHash $target) -ne $originalHash) { throw 'Rollback integrity failed' }
    $fixtureIdle = $false
    $rejected = $false
    try { ReplaceReviewedFile $record $candidate $candidateHash $originalHash } catch { $rejected = $_.Exception.Message -eq 'Fixture is not idle' }
    if (-not $rejected -or (FileHash $target) -ne $originalHash) { throw 'Idle guard did not reject without writes' }
    [pscustomobject]@{ replace = 'pass'; rollback = 'pass'; nonIdleGuard = 'pass'; originalBackupPreserved = $true; realInstalledFilesTouched = 0; installerSha256 = FileHash $InstallerPath } | ConvertTo-Json
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    if ($resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedFixture).StartsWith('bridge-replace-fixture-')) {
        Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    } else { throw 'Fixture cleanup path escaped its temporary parent' }
}
