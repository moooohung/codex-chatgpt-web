param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'schedule-bridge-maintenance.ps1')
$directory = Join-Path ([IO.Path]::GetTempPath()) ('bridge-idle-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$fixtureJob = Join-Path $directory 'task-offline-protected.json'
WriteBridgeJson $fixtureJob @{ id = 'task-offline-protected'; status = 'running' }
$outsideRejected = $false
try { AssertBridgeProtectedJobPath $fixtureJob | Out-Null } catch { $outsideRejected = $true }
if (-not $outsideRejected) { throw 'Production job path guard accepted a temporary fixture path' }
# Only this isolated test admits its one temporary file. Production retains its exact plugin-root guard.
$originalValidator = ${function:AssertBridgeProtectedJobPath}
function AssertBridgeProtectedJobPath([string]$Path) {
    if ($Path -eq $fixtureJob) { return $fixtureJob }
    return & $originalValidator $Path
}
$fixtureSource = Join-Path $directory 'fixture.ts'
[IO.File]::WriteAllText($fixtureSource, @'
let busy=true;
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
 const path=new URL(request.url).pathname;
 if(path==="/idle")busy=false;
 if(path==="/shutdown")setTimeout(()=>process.exit(0),20);
 if(path==="/admin/drain")throw Error("fixture must never drain");
 return Response.json({status:"ok",pid:process.pid,active_browser_turns:0,active_http_turns:busy?1:0});
}});
await Bun.write(process.argv[2],JSON.stringify({port:server.port}));
setTimeout(()=>process.exit(0),30000);
'@)
$readyPath = Join-Path $directory 'ready.json'
$fixture = Start-Process -FilePath 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/bun.exe' -ArgumentList @('"' + $fixtureSource + '"', '"' + $readyPath + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log')
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $readyPath)) { if ([DateTime]::UtcNow -ge $deadline) { throw 'Fixture did not start' }; Start-Sleep -Milliseconds 50 }
    $uri = 'http://127.0.0.1:' + (Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json).port
    $reservation = @{ healthUri = $uri; priorDaemonPid = $fixture.Id; waitForIdleSeconds = 1; allowActiveBrowserTurns = $false; protectedJobPaths = @($fixtureJob); statePath = Join-Path $directory 'state.json' }
    $state = [ordered]@{ phase = 'prepared'; shutdownRequested = $false }
    $busyRejected = $false
    try { WaitBridgeMaintenanceWindow $reservation $state } catch { $busyRejected = $_.Exception.Message -match 'no drain or quit' }
    if (-not $busyRejected -or $state.shutdownRequested) { throw 'Native HTTP activity did not preserve the running fixture' }
    Invoke-RestMethod -Uri ($uri + '/idle') -TimeoutSec 1 | Out-Null
    $jobRejected = $false
    try { WaitBridgeMaintenanceWindow $reservation $state } catch { $jobRejected = $_.Exception.Message -match 'no drain or quit' }
    if (-not $jobRejected -or $state.shutdownRequested) { throw 'A running protected job was treated as idle between native requests' }
    WriteBridgeJson $fixtureJob @{ id = 'task-offline-protected'; status = 'completed' }
    $reservation.waitForIdleSeconds = 5
    WaitBridgeMaintenanceWindow $reservation $state
    if ($state.phase -ne 'prepared' -or -not $state.idleWindowObservedAt -or $state.shutdownRequested) { throw 'Two idle samples did not acknowledge the safe window' }
    $reservation.allowActiveBrowserTurns = $true
    $activeRejected = $false
    try { WaitBridgeMaintenanceWindow $reservation $state } catch { $activeRejected = $_.Exception.Message -match 'cannot authorize' }
    if (-not $activeRejected) { throw 'Idle waiting allowed active cancellation' }
    $report = @{ passed = $true; cases = @('production_path_guard','native_http_wait_no_drain','protected_job_wait_between_requests','two_idle_samples','active_override_rejected'); fixtureRoot = $directory; realLauncherQuitRequests = 0; productionJobFilesChanged = 0; fixtureValidatorOverridden = $true }
    if ($OutputDirectory) { [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory)) | Out-Null; WriteBridgeJson (Join-Path $OutputDirectory 'maintenance-idle-tests.json') $report }
    $report | ConvertTo-Json -Depth 5
} finally { try { Invoke-RestMethod -Uri ($uri + '/shutdown') -TimeoutSec 1 | Out-Null } catch {}; $fixture.WaitForExit(3000) | Out-Null }
