param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'schedule-bridge-maintenance.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('bridge-engine-fixture-' + [Guid]::NewGuid().ToString('N'))
$installed = Join-Path $root 'installed'
$package = Join-Path $root 'package'
[IO.Directory]::CreateDirectory($installed) | Out-Null
[IO.Directory]::CreateDirectory($package) | Out-Null
$launcher = Join-Path $installed 'launcher.exe'
$source = Join-Path $package 'launcher.exe'
$added = Join-Path $installed 'new.dll'
$addedSource = Join-Path $package 'new.dll'
[IO.File]::WriteAllText($launcher, 'original executable')
[IO.File]::WriteAllText($source, 'reviewed candidate executable')
[IO.File]::WriteAllText($addedSource, 'reviewed added dependency')
$records = @(
    @{ target = $launcher; source = $source; originalSha256 = BridgeFileHash $launcher; candidateSha256 = BridgeFileHash $source },
    @{ target = $added; source = $addedSource; originalSha256 = $null; candidateSha256 = BridgeFileHash $addedSource }
)
$plan = @{ operation = 'full-launcher-upgrade'; packageRoot = $package; launcherFiles = $records }
AssertBridgeLauncherFiles $plan $launcher
$planPath = Join-Path $root 'plan.json'
WriteBridgeJson $planPath $plan
$reservation = @{
    schemaVersion = 1; taskName = 'CodexWebGPT-RestartFixture-' + [Guid]::NewGuid().ToString('N')
    operation = 'Install'; workerPath = $PSCommandPath; workerSha256 = BridgeFileHash $PSCommandPath
    planPath = $planPath; planSha256 = BridgeFileHash $planPath
    launcherPath = $launcher; launcherSha256 = $records[0].originalSha256; launcherCandidateSha256 = $records[0].candidateSha256
    healthUri = 'http://127.0.0.1:1/healthz'; files = $records
}
function AssertFixture($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function RejectFixture([scriptblock]$Body) {
    $rejected = $false
    try { & $Body } catch { $rejected = $true }
    AssertFixture $rejected 'Malformed launcher plan or executable was accepted'
}
AssertFixture ((BridgeRuntimeState $reservation) -eq 'original') 'Missing new file was not an original installation'
AssertBridgeReservation $reservation
[IO.File]::Copy($source, $launcher, $true)
AssertBridgeReservation $reservation
AssertFixture ((BridgeRuntimeState $reservation) -eq 'mixed') 'Interrupted engine replacement was not detected'
[IO.File]::Copy($addedSource, $added, $false)
AssertFixture ((BridgeRuntimeState $reservation) -eq 'candidate') 'Complete engine candidate was not accepted'
[IO.File]::WriteAllText($launcher, 'unreviewed executable')
RejectFixture { AssertBridgeReservation $reservation }
AssertFixture ((BridgeRuntimeState $reservation) -eq 'unknown') 'Unknown engine did not fail closed'
[IO.File]::Copy($source, $launcher, $true)
$reservation.launcherCandidateSha256 = $records[1].candidateSha256
RejectFixture { AssertBridgeReservation $reservation }
$reservation.launcherCandidateSha256 = $records[0].candidateSha256
$plan.launcherFiles = @($records[0], $records[0])
RejectFixture { AssertBridgeLauncherFiles $plan $launcher }
$plan.launcherFiles = @($records[1])
RejectFixture { AssertBridgeLauncherFiles $plan $launcher }
$plan.launcherFiles = @($records[0], @{ target = Join-Path $installed '../escaped.dll'; source = $addedSource; originalSha256 = $null; candidateSha256 = $records[1].candidateSha256 })
RejectFixture { AssertBridgeLauncherFiles $plan $launcher }
$plan.launcherFiles = @($records[0], @{ target = Join-Path $installed 'resources/runtime/foreign.dll'; source = $addedSource; originalSha256 = $null; candidateSha256 = $records[1].candidateSha256 })
RejectFixture { AssertBridgeLauncherFiles $plan $launcher }
$plan.launcherFiles = @($records[0], @{ target = $added; source = $launcher; originalSha256 = $null; candidateSha256 = $records[0].candidateSha256 })
RejectFixture { AssertBridgeLauncherFiles $plan $launcher }
$plan.launcherFiles = @($records[0], @{ target = $added; source = $addedSource; originalSha256 = ''; candidateSha256 = $records[1].candidateSha256 })
RejectFixture { AssertBridgeLauncherFiles $plan $launcher }
$plan.launcherFiles = $records
$plan.operation = 'full-runtime-upgrade'
RejectFixture { AssertBridgeLauncherFiles $plan $launcher }
$report = @{ passed = $true; cases = 13; scope = 'reviewed engine hashes, added files, interrupted replacement, path and duplicate rejection'; fixtureRoot = $root; realLauncherQuitRequests = 0 }
if ($OutputDirectory) { [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory)) | Out-Null; WriteBridgeJson (Join-Path $OutputDirectory 'maintenance-engine-tests.json') $report }
$report | ConvertTo-Json
