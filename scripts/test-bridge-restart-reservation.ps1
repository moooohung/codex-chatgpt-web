param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'schedule-bridge-maintenance.ps1'
. $source
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-bridge-restart-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$results = [Collections.Generic.List[object]]::new()
$bunPath = 'C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\bun.exe'
$powershellPath = 'C:\Program Files\PowerShell\7\pwsh.exe'
$realDescriptorPath = 'C:\Users\Administrator\.codex-chatgpt-web\runtime\launcher-browser.json'
$realBefore = Get-Content -LiteralPath $realDescriptorPath -Raw | ConvertFrom-Json
function AssertFixture([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function FixtureResult([string]$Name, $Evidence) { $results.Add([pscustomobject]@{ name = $Name; evidence = $Evidence }) }
function WaitFixture([string]$Path, [string]$Phase, [int]$Seconds = 35) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if ($state.phase -eq $Phase) { return $state }
        if ($state.phase -eq 'recovery_failed_scheduled_retry') { throw 'Fixture recovery failed: ' + $state.recoveryError }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Fixture deadline: ' + $state.phase }
        Start-Sleep -Milliseconds 300
    } while ($true)
}
function WaitFixtureGuardian($Armed) {
    if ($Armed.backend -ne 'independent_guardian') { return }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Armed.guardianPid)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Completed fixture guardian did not exit' }
        Start-Sleep -Milliseconds 200
    }
}
try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $launchScript = Join-Path $fixtureRoot 'fixture-launcher.ts'
    $launchLog = Join-Path $fixtureRoot 'launches.jsonl'
    $launcherSource = @'
import { appendFileSync } from "node:fs";
const server = Bun.serve({hostname:"127.0.0.1", port:Number(process.argv[2]), fetch(request) {
  if (new URL(request.url).pathname === "/shutdown") {
    setTimeout(() => { server.stop(true); process.exit(0); }, 50);
    return Response.json({status:"stopping"});
  }
  return Response.json({status:"ok", service:"codex-chatgpt-web", accepting_turns:true, pid:process.pid});
}});
appendFileSync(process.argv[3], JSON.stringify({pid:process.pid, at:new Date().toISOString()}) + "\n");
setTimeout(() => { server.stop(true); process.exit(0); }, 120_000);
'@
    [IO.File]::WriteAllText($launchScript, $launcherSource)
    $files = @()
    foreach ($name in @('a', 'b')) {
        $target = Join-Path $fixtureRoot ($name + '.target')
        $backup = Join-Path $fixtureRoot ($name + '.backup')
        $candidate = Join-Path $fixtureRoot ($name + '.candidate')
        [IO.File]::WriteAllText($target, 'original-' + $name)
        [IO.File]::WriteAllText($backup, 'original-' + $name)
        [IO.File]::WriteAllText($candidate, 'candidate-' + $name)
        $files += [pscustomobject]@{ target = $target; backup = $backup; source = $candidate; originalSha256 = BridgeFileHash $target; candidateSha256 = BridgeFileHash $candidate }
    }
    $planPath = Join-Path $fixtureRoot 'plan.json'
    WriteBridgeJson $planPath @{ files = $files }
    $installerPath = Join-Path $fixtureRoot 'fixture-installer.ps1'
    [IO.File]::WriteAllText($installerPath, @'
param([string]$PlanPath,[string]$Action,[switch]$IdleWindowAuthorized)
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
if (-not $IdleWindowAuthorized) { throw 'Missing idle flag' }
if ($Action -eq 'Install') {
    [IO.File]::Copy($plan.files[0].source,$plan.files[0].target,$true)
    throw 'Intentional fixture installation failure'
}
if ($Action -ne 'Rollback') { throw 'Unknown fixture action' }
foreach ($file in $plan.files) {
    $current = (Get-FileHash -LiteralPath $file.target).Hash.ToLowerInvariant()
    if ($current -ne $file.originalSha256 -and $current -ne $file.candidateSha256) { throw 'Unknown fixture target' }
    if ((Get-FileHash -LiteralPath $file.backup).Hash.ToLowerInvariant() -ne $file.originalSha256) { throw 'Bad fixture backup' }
    [IO.File]::Copy($file.backup,$file.target,$true)
}
'@)
    function FixtureReservation([string]$Name) {
        $directory = Join-Path $fixtureRoot $Name
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        return [ordered]@{
            schemaVersion = 1; taskName = 'CodexWebGPT-RestartFixture-' + [Guid]::NewGuid().ToString('N'); operation = 'Install'
            powershellPath = $powershellPath; workerPath = Join-Path $directory 'worker.ps1'; workerSha256 = $null
            statePath = Join-Path $directory 'state.json'; lockPath = Join-Path $fixtureRoot 'fixture-maintenance.lock'
            launcherPath = $bunPath; launcherSha256 = BridgeFileHash $bunPath
            launcherArguments = @('"' + $launchScript + '"', [string]$port, '"' + $launchLog + '"')
            executableRoot = $fixtureRoot + '\'; runtimeRoot = $fixtureRoot; runtimeCommandPattern = 'fixture-launcher\.ts'
            planPath = $planPath; planSha256 = BridgeFileHash $planPath; files = $files
            installerPath = $installerPath; installerSha256 = BridgeFileHash $installerPath
            healthUri = 'http://127.0.0.1:' + $port + '/healthz'; configPath = $null
            priorDaemonPid = 0; priorLauncherPid = 0
        }
    }
    # The process that reserves the task exits before the scheduler runs recovery.
    # Persist the interrupted install stage; an OS-owned retry must not install again.
    $crash = FixtureReservation 'interrupted-controller'
    $inputPath = Join-Path $fixtureRoot 'fixture-input.json'
    WriteBridgeJson $inputPath $crash
    $armScript = Join-Path $fixtureRoot 'arm-fixture.ps1'
    [IO.File]::WriteAllText($armScript, @'
param([string]$Source,[string]$InputPath)
$ErrorActionPreference = 'Stop'
. $Source
$reservation = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json -AsHashtable
$armed = RegisterBridgeReservation $reservation $Source
$state = Get-Content -LiteralPath $reservation.statePath -Raw | ConvertFrom-Json -AsHashtable
$state.phase = 'installer_requested'
$state.installerInvocations = 1
$state.shutdownRequested = $true
$state.operationError = 'Simulated controller loss during installation'
WriteBridgeJson $reservation.statePath $state
$armed | ConvertTo-Json -Depth 5
'@)
    [IO.File]::Copy($files[0].source, $files[0].target, $true)
    $armStdout = Join-Path $fixtureRoot 'arm.stdout.log'
    $armStderr = Join-Path $fixtureRoot 'arm.stderr.log'
    $armArguments = '-NoProfile -NonInteractive -File "' + $armScript + '" -Source "' + $source + '" -InputPath "' + $inputPath + '"'
    $armingProcess = Start-Process -FilePath $powershellPath -ArgumentList $armArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $armStdout -RedirectStandardError $armStderr
    AssertFixture ($armingProcess.WaitForExit(20000)) 'Reserving process did not exit independently'
    $armingProcess.WaitForExit()
    if ($armingProcess.ExitCode -ne 0) { throw 'Fixture reservation failed: ' + (Get-Content -LiteralPath $armStderr -Raw) }
    $crashState = WaitFixture $crash.statePath 'complete'
    AssertFixture ($crashState.installerInvocations -eq 1 -and $crashState.launcherStarts -eq 1 -and $crashState.runtimeStateAtRestart -eq 'original') 'Interrupted transaction was repeated or did not recover original files'
    AssertFixture ((BridgeRuntimeState $crash) -eq 'original') 'Partial fixture rollback failed'
    $crashArmed = Get-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($crash.statePath)) 'armed.json') -Raw | ConvertFrom-Json
    WaitFixtureGuardian $crashArmed
    FixtureResult 'independent_recovery_after_reserving_process_exit' @{ state = $crashState; backend = $crashArmed.backend; taskRemoved = @(Get-ScheduledTask -TaskName $crash.taskName -ErrorAction SilentlyContinue).Count -eq 0 }

    # A repeat recovery sees the existing healthy fixture and starts nothing.
    $existing = FixtureReservation 'existing-owner'
    $existingArmed = RegisterBridgeReservation $existing $source
    $existingState = Get-Content -LiteralPath $existing.statePath -Raw | ConvertFrom-Json -AsHashtable
    $existingState.phase = 'operation_failed_recovery_pending'
    WriteBridgeJson $existing.statePath $existingState
    $existingResult = WaitFixture $existing.statePath 'complete'
    WaitFixtureGuardian $existingArmed
    AssertFixture ($existingResult.launcherStarts -eq 0 -and $existingResult.daemonPid -eq $crashState.daemonPid) 'Existing healthy launcher was duplicated'
    FixtureResult 'existing_owner_not_duplicated' $existingResult
    Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/shutdown') -Method Post -TimeoutSec 3 | Out-Null
    WaitBridgeIdle $crash 10

    # Exercise the actual transaction's finally path with a failing fixture installer.
    $failure = FixtureReservation 'installer-failure'
    $failureArmed = RegisterBridgeReservation $failure $source
    function RequestBridgeQuit($Reservation, $State) {
        AssertFixture (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($Reservation.statePath)) 'armed.json')) 'Quit ran before verified reservation'
        $State.shutdownRequested = $true
        BridgePhase $Reservation $State 'waiting_for_owned_exit'
    }
    # Run now, before its timer. Removing the task at completion cancels the timer.
    InvokeReservedBridgeMaintenance $failure
    $failureState = Get-Content -LiteralPath $failure.statePath -Raw | ConvertFrom-Json
    WaitFixtureGuardian $failureArmed
    AssertFixture ($failureState.phase -eq 'complete' -and $failureState.operationSucceeded -eq $false -and $failureState.recoveredAfterFailure -and $failureState.launcherStarts -eq 1) 'Installer failure did not execute restart recovery'
    FixtureResult 'installer_failure_finally_restarts' $failureState
    Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/shutdown') -Method Post -TimeoutSec 3 | Out-Null
    WaitBridgeIdle $failure 10

    # A late delivery of an already completed reservation must not reopen an app
    # that has since been closed. Keep the guardian alive to test the real guard.
    $completed = FixtureReservation 'completed-reservation'
    $completedArmed = RegisterBridgeReservation $completed $source
    $completedState = Get-Content -LiteralPath $completed.statePath -Raw | ConvertFrom-Json -AsHashtable
    $completedState.phase = 'complete'
    WriteBridgeJson $completed.statePath $completedState
    InvokeReservedBridgeMaintenance $completed
    $completedState = Get-Content -LiteralPath $completed.statePath -Raw | ConvertFrom-Json
    AssertFixture ($completedState.launcherStarts -eq 0 -and @(BridgeProcesses $completed).Count -eq 0) 'Completed reservation reopened a closed launcher'
    WaitFixtureGuardian $completedArmed
    FixtureResult 'completed_reservation_does_not_reopen' $completedState

    $unknown = FixtureReservation 'unknown-target'
    [IO.File]::Copy($source, $unknown.workerPath, $false)
    $unknown.workerSha256 = BridgeFileHash $unknown.workerPath
    $unknownState = [ordered]@{ phase = 'installer_requested'; launcherStarts = 0 }
    [IO.File]::WriteAllText($files[0].target, 'unreviewed-fixture-change')
    $rejected = $false
    try { RestoreBridgeLauncher $unknown $unknownState } catch { $rejected = $_.Exception.Message -match 'complete reviewed version' }
    AssertFixture ($rejected -and $unknownState.launcherStarts -eq 0) 'Unknown runtime started a launcher'
    FixtureResult 'unknown_runtime_not_started' @{ rejected = $rejected; launcherStarts = $unknownState.launcherStarts }
    [IO.File]::Copy($files[0].backup, $files[0].target, $true)
    $reservationRejected = $false
    try { InvokeReservedBridgeMaintenance $unknown } catch { $reservationRejected = $_.Exception.Message -match 'reservation receipt is missing' }
    AssertFixture $reservationRejected 'Missing reservation did not prevent quit'
    FixtureResult 'quit_requires_verified_reservation' @{ rejected = $reservationRejected }
    $realAfter = Get-Content -LiteralPath $realDescriptorPath -Raw | ConvertFrom-Json
    AssertFixture ($realBefore.pid -eq $realAfter.pid) 'Real launcher changed during fixture tests'
    $report = [ordered]@{ passed = $true; cases = $results; fixtureRoot = $fixtureRoot; realLauncherPidBefore = $realBefore.pid; realLauncherPidAfter = $realAfter.pid; realLauncherStopRequests = 0; realInstalledFileWrites = 0 }
    if ($OutputDirectory) {
        [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory)) | Out-Null
        WriteBridgeJson (Join-Path $OutputDirectory 'restart-reservation-tests.json') $report
    }
    $report | ConvertTo-Json -Depth 12
} finally {
    # Only this fixture's named tasks and private loopback service are cleaned up.
    foreach ($reservation in @($crash, $existing, $failure, $completed)) {
        if ($reservation -and (Get-ScheduledTask -TaskName $reservation.taskName -ErrorAction SilentlyContinue)) { Unregister-ScheduledTask -TaskName $reservation.taskName -Confirm:$false }
    }
    if ($port) {
        try { Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/shutdown') -Method Post -TimeoutSec 2 | Out-Null } catch { }
    }
    # Preserve generated fixtures, receipts, and installer logs for inspection.
}
