param(
    [ValidateSet('Reserve', 'Run', 'Supervise', 'Probe')][string]$Action = 'Reserve',
    [ValidateSet('Restart', 'Install', 'Rollback')][string]$Operation = 'Restart',
    [string]$PlanPath,
    [string]$PlanSha256,
    [string]$InstallerPath,
    [string]$InstallerSha256,
    [string]$ReservationPath,
    [string]$ReservationSha256,
    [switch]$ShutdownAuthorized,
    [switch]$AllowActiveBrowserTurns
)

$ErrorActionPreference = 'Stop'

function BridgeFileHash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function WriteBridgeJson([string]$Path, $Value) {
    $temporary = $Path + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12))
    [IO.File]::Move($temporary, $Path, $true)
}
function BridgeProcesses($Reservation) {
    $active = @()
    foreach ($process in (Get-CimInstance Win32_Process)) {
        $executable = [string]$process.ExecutablePath
        $command = ([string]$process.CommandLine).Replace('/', '\')
        if ($executable.StartsWith($Reservation.executableRoot, [StringComparison]::OrdinalIgnoreCase) -or
            ($command.IndexOf($Reservation.runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $command -match $Reservation.runtimeCommandPattern)) {
            $active += [pscustomobject]@{ pid = $process.ProcessId; executable = $executable; createdAt = $process.CreationDate.ToUniversalTime().ToString('o') }
        }
    }
    return $active
}
function BridgeInstallerActive($Reservation) {
    if (-not $Reservation.installerPath) { return $false }
    foreach ($process in (Get-CimInstance Win32_Process)) {
        if (([string]$process.CommandLine).Replace('/', '\').IndexOf($Reservation.installerPath.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}
function BridgeRuntimeState($Reservation) {
    $original = $true
    $candidate = $true
    foreach ($file in $Reservation.files) {
        $hash = BridgeFileHash $file.target
        if ($hash -ne $file.originalSha256 -and $hash -ne $file.candidateSha256) { return 'unknown' }
        if ($hash -ne $file.originalSha256) { $original = $false }
        if ($hash -ne $file.candidateSha256) { $candidate = $false }
    }
    if ($candidate) { return 'candidate' }
    if ($original) { return 'original' }
    return 'mixed'
}
function BridgePhase($Reservation, $State, [string]$Phase) {
    $State.phase = $Phase
    $State.updatedAt = [DateTime]::UtcNow.ToString('o')
    WriteBridgeJson $Reservation.statePath $State
}
function BridgeReservationDirectory($Reservation) { return [IO.Path]::GetDirectoryName($Reservation.statePath) }
function CompleteBridgeReservation($Reservation) {
    $armed = Get-Content -LiteralPath (Join-Path (BridgeReservationDirectory $Reservation) 'armed.json') -Raw | ConvertFrom-Json -DateKind String
    if ($armed.backend -eq 'task_scheduler') { Unregister-ScheduledTask -TaskName $Reservation.taskName -Confirm:$false -ErrorAction Stop }
}
function AssertBridgeReservation($Reservation) {
    if ($Reservation.schemaVersion -ne 1 -or $Reservation.taskName -notmatch '^CodexWebGPT-(Maintenance|RestartProbe|RestartFixture)-[a-f0-9]{32}$') { throw 'Unexpected restart reservation' }
    foreach ($guard in @(
        @{ path = $Reservation.workerPath; hash = $Reservation.workerSha256 },
        @{ path = $Reservation.launcherPath; hash = $Reservation.launcherSha256 },
        @{ path = $Reservation.planPath; hash = $Reservation.planSha256 }
    )) {
        if ($guard.hash -notmatch '^[a-f0-9]{64}$' -or (BridgeFileHash $guard.path) -ne $guard.hash) { throw 'Reserved file changed: ' + $guard.path }
    }
    if ($Reservation.installerPath -and (BridgeFileHash $Reservation.installerPath) -ne $Reservation.installerSha256) { throw 'Reviewed installer changed' }
    $healthUri = [Uri]$Reservation.healthUri
    if ($healthUri.Scheme -ne 'http' -or $healthUri.Host -ne '127.0.0.1') { throw 'Health endpoint must be loopback HTTP' }
    if ($Reservation.operation -notin @('Restart', 'Install', 'Rollback', 'Probe')) { throw 'Unknown maintenance operation' }
}
function RegisterBridgeReservation($Reservation, [string]$WorkerSource) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Reservation.statePath)) | Out-Null
    [IO.File]::Copy($WorkerSource, $Reservation.workerPath, $false)
    $Reservation.workerSha256 = BridgeFileHash $Reservation.workerPath
    $manifestPath = Join-Path ([IO.Path]::GetDirectoryName($Reservation.statePath)) 'reservation.json'
    WriteBridgeJson $manifestPath $Reservation
    $manifestHash = BridgeFileHash $manifestPath
    $taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Reservation.workerPath + '" -Action Run -ReservationPath "' + $manifestPath + '" -ReservationSha256 ' + $manifestHash
    $taskAction = New-ScheduledTaskAction -Execute $Reservation.powershellPath -Argument $taskArguments
    $trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddSeconds(5))
    $trigger.EndBoundary = [DateTime]::Now.AddMinutes(30).ToString('s')
    $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
    $state = [ordered]@{ phase = 'prepared'; preparedAt = [DateTime]::UtcNow.ToString('o'); operation = $Reservation.operation; shutdownRequested = $false; browserTurnsAtQuit = 0; installerInvocations = 0; launcherStarts = 0; operationSucceeded = $false }
    WriteBridgeJson $Reservation.statePath $state
    $schedulerError = $null
    try {
        Register-ScheduledTask -TaskName $Reservation.taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description 'One maintenance transaction: normal quit, reviewed overlay, launcher recovery. Armed before shutdown; retries recover without repeating the quit or installation.' -ErrorAction Stop | Out-Null
    } catch { $schedulerError = $_.Exception.Message }
    if ($schedulerError) {
        # An independent Windows process is the local fallback when task creation
        # is denied. It owns the timer and worker retries after this caller exits.
        $guardianArguments = $taskArguments.Replace('-Action Run ', '-Action Supervise ')
        $directory = BridgeReservationDirectory $Reservation
        # Shell execution creates a separate hidden Windows process without
        # inheriting the caller's redirected native-command pipe handles.
        $guardian = Start-Process -FilePath $Reservation.powershellPath -ArgumentList $guardianArguments -WindowStyle Hidden -PassThru
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $guardian.Id)
        if (-not $owner -or $owner.ExecutablePath -ne $Reservation.powershellPath) { throw 'Independent restart guardian did not start; no quit was requested' }
        $armed = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); backend = 'independent_guardian'; taskName = $Reservation.taskName; manifestPath = $manifestPath; manifestSha256 = $manifestHash; execute = $Reservation.powershellPath; guardianPid = $owner.ProcessId; guardianCreatedAt = $owner.CreationDate.ToUniversalTime().ToString('o'); restartCount = 3; statePath = $Reservation.statePath; schedulerError = $schedulerError; rawRuntimeTokensRetained = 0 }
        WriteBridgeJson (Join-Path $directory 'armed.json') $armed
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $readyPath = Join-Path $directory 'guardian-ready.json'
            if (Test-Path -LiteralPath $readyPath) {
                $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json -DateKind String
                if ($ready.pid -eq $armed.guardianPid -and $ready.manifestSha256 -eq $manifestHash) { return $armed }
                throw 'Restart guardian acknowledgement differs from the reserved process'
            }
            if ($guardian.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Restart guardian did not acknowledge readiness; no quit was requested' }
            Start-Sleep -Milliseconds 100
        } while ($true)
    }
    # Only the scheduled process may close the launcher, after this registration is verified.
    $task = Get-ScheduledTask -TaskName $Reservation.taskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $Reservation.taskName -ErrorAction Stop
    if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $Reservation.powershellPath -or $task.Actions[0].Arguments -cne $taskArguments -or
        $task.Principal.UserId -ne $principal.UserId -or $task.Principal.LogonType -ne 'Interactive' -or
        $task.Settings.RestartCount -ne 3 -or $info.NextRunTime -eq [DateTime]::MinValue) {
        Unregister-ScheduledTask -TaskName $Reservation.taskName -Confirm:$false -ErrorAction Stop
        throw 'Restart reservation did not verify; launcher shutdown was not requested'
    }
    $armed = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); backend = 'task_scheduler'; taskName = $Reservation.taskName; manifestPath = $manifestPath; manifestSha256 = $manifestHash; nextRunAt = $info.NextRunTime.ToUniversalTime().ToString('o'); execute = $task.Actions[0].Execute; interactive = $true; restartCount = 3; statePath = $Reservation.statePath; rawRuntimeTokensRetained = 0 }
    WriteBridgeJson (Join-Path ([IO.Path]::GetDirectoryName($Reservation.statePath)) 'armed.json') $armed
    return $armed
}
function InvokeBridgeRestartGuardian($Reservation, [string]$ManifestPath, [string]$ManifestHash) {
    AssertBridgeReservation $Reservation
    $directory = BridgeReservationDirectory $Reservation
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $armedPath = Join-Path $directory 'armed.json'
    while (-not (Test-Path -LiteralPath $armedPath)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Guardian has no verified reservation receipt' }
        Start-Sleep -Milliseconds 100
    }
    $armed = Get-Content -LiteralPath $armedPath -Raw | ConvertFrom-Json -DateKind String
    if ($armed.backend -ne 'independent_guardian' -or $armed.guardianPid -ne $PID -or $armed.manifestSha256 -ne $ManifestHash) { throw 'Guardian receipt changed' }
    WriteBridgeJson (Join-Path $directory 'guardian-ready.json') @{ pid = $PID; at = [DateTime]::UtcNow.ToString('o'); manifestSha256 = $ManifestHash; readyBeforeQuit = $true }
    Start-Sleep -Seconds 5
    for ($attempt = 0; $attempt -le 3; $attempt++) {
        $state = Get-Content -LiteralPath $Reservation.statePath -Raw | ConvertFrom-Json
        if ($state.phase -in @('complete', 'reservation_probe_complete')) { break }
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Reservation.workerPath + '" -Action Run -ReservationPath "' + $ManifestPath + '" -ReservationSha256 ' + $ManifestHash
        $worker = Start-Process -FilePath $Reservation.powershellPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory ('worker-' + $attempt + '.stdout.log')) -RedirectStandardError (Join-Path $directory ('worker-' + $attempt + '.stderr.log'))
        # Poll rather than forcibly ending an owned transaction or surviving writer.
        $worker.WaitForExit()
        $state = Get-Content -LiteralPath $Reservation.statePath -Raw | ConvertFrom-Json
        WriteBridgeJson (Join-Path $directory 'guardian-result.json') @{ at = [DateTime]::UtcNow.ToString('o'); guardianPid = $PID; workerPid = $worker.Id; attempt = $attempt; exitCode = $worker.ExitCode; phase = $state.phase }
        if ($state.phase -in @('complete', 'reservation_probe_complete')) { return }
        if ($attempt -lt 3) { Start-Sleep -Seconds 60 }
    }
    $state = Get-Content -LiteralPath $Reservation.statePath -Raw | ConvertFrom-Json
    if ($state.phase -notin @('complete', 'reservation_probe_complete')) { throw 'Independent restart recovery exhausted its three retries; receipts retained' }
}
function RequestBridgeQuit($Reservation, $State) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Reservation.priorLauncherPid)
    if (-not $owner -or $owner.ExecutablePath -ne $Reservation.launcherPath -or $owner.CreationDate.ToUniversalTime().ToString('o') -ne $Reservation.priorLauncherCreatedAt) { throw 'Reviewed launcher owner changed before quit' }
    $health = Invoke-RestMethod -Uri $Reservation.healthUri -TimeoutSec 5
    if ($health.status -ne 'ok' -or $health.pid -ne $Reservation.priorDaemonPid -or ($health.active_browser_turns -ne 0 -and -not $Reservation.allowActiveBrowserTurns)) { throw 'Reviewed daemon or browser work changed before quit' }
    $config = Get-Content -LiteralPath $Reservation.configPath -Raw | ConvertFrom-Json
    $descriptor = Get-Content -LiteralPath $Reservation.descriptorPath -Raw | ConvertFrom-Json
    $endpoint = [Uri]$descriptor.endpoint
    if ($descriptor.pid -ne $Reservation.priorLauncherPid -or $endpoint.Scheme -ne 'http' -or $endpoint.Host -ne '127.0.0.1') { throw 'Owned browser descriptor changed' }
    $version = Invoke-RestMethod -Uri ([Uri]::new($endpoint, '/json/version')) -TimeoutSec 5
    $socketUri = [Uri]$version.webSocketDebuggerUrl
    if ($socketUri.Host -ne $endpoint.Host -or $socketUri.Port -ne $endpoint.Port -or $socketUri.Scheme -ne 'ws' -or -not $socketUri.AbsolutePath.StartsWith('/devtools/browser/')) { throw 'Unexpected owned browser socket' }
    $headers = @{ Authorization = 'Bearer ' + $config.controlToken }
    $State.shutdownRequested = $true
    $State.browserTurnsAtQuit = $health.active_browser_turns
    BridgePhase $Reservation $State 'shutdown_requested'
    $drain = Invoke-RestMethod -Uri ([Uri]::new([Uri]$Reservation.healthUri, '/admin/drain')) -Method Post -Headers $headers -TimeoutSec 5
    if ($drain.status -ne 'ok' -or $drain.accepting_turns -ne $false -or ($drain.active_browser_turns -ne 0 -and -not $Reservation.allowActiveBrowserTurns)) {
        Invoke-RestMethod -Uri ([Uri]::new([Uri]$Reservation.healthUri, '/admin/resume')) -Method Post -Headers $headers -TimeoutSec 5 | Out-Null
        throw 'Idle browser drain was not acknowledged'
    }
    $State.browserTurnsAtQuit = [Math]::Max($State.browserTurnsAtQuit, $drain.active_browser_turns)
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $timeout = [Threading.CancellationTokenSource]::new(10000)
    try {
        $socket.ConnectAsync($socketUri, $timeout.Token).GetAwaiter().GetResult()
        $message = [Text.Encoding]::UTF8.GetBytes('{"id":1,"method":"Browser.close","params":{}}')
        $socket.SendAsync([ArraySegment[byte]]::new($message), [Net.WebSockets.WebSocketMessageType]::Text, $true, $timeout.Token).GetAwaiter().GetResult()
        $State.quitSentAt = [DateTime]::UtcNow.ToString('o')
        BridgePhase $Reservation $State 'waiting_for_owned_exit'
        # Electron's Browser.close requests normal Quit without a protocol response.
    } finally { $socket.Dispose(); $timeout.Dispose() }
}
function WaitBridgeIdle($Reservation, [int]$Seconds = 180) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (@(BridgeProcesses $Reservation).Count -eq 0 -and -not (BridgeInstallerActive $Reservation)) { return }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Owned launcher, daemon, or installer remains active; recovery will not start a duplicate' }
        Start-Sleep -Milliseconds 1000
    } while ($true)
}
function InvokeBridgeInstaller($Reservation, [string]$InstallAction) {
    AssertBridgeReservation $Reservation
    if (@(BridgeProcesses $Reservation).Count -gt 0 -or (BridgeInstallerActive $Reservation)) { throw 'Bridge or reviewed installer remains active' }
    $output = & $Reservation.powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Reservation.installerPath -PlanPath $Reservation.planPath -Action $InstallAction -IdleWindowAuthorized 2>&1
    $code = $LASTEXITCODE
    [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($Reservation.statePath)) ($InstallAction.ToLowerInvariant() + '.log')), ($output -join [Environment]::NewLine))
    if ($code -ne 0) { throw 'Reviewed installer failed: exit ' + $code }
}
function RestoreBridgeLauncher($Reservation, $State) {
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    do {
        $active = @(BridgeProcesses $Reservation)
        $writer = BridgeInstallerActive $Reservation
        $health = $null
        if (-not $writer) {
            try {
                $health = Invoke-RestMethod -Uri $Reservation.healthUri -TimeoutSec 2
                if ($health.status -eq 'ok' -and $health.service -eq 'codex-chatgpt-web' -and $health.accepting_turns -eq $true -and
                    @($active | Where-Object { $_.pid -eq $health.pid }).Count -eq 1) {
                    $State.daemonPid = $health.pid
                    $State.healthyAt = [DateTime]::UtcNow.ToString('o')
                    BridgePhase $Reservation $State 'launcher_healthy'
                    return
                }
            } catch { }
            if ($active.Count -eq 0) { break }
            # A rejected pre-quit drain must not leave the still-owned daemon paused.
            if (-not $State.quitSentAt -and $Reservation.configPath -and $health -and $health.pid -eq $Reservation.priorDaemonPid -and $health.accepting_turns -eq $false) {
                $config = Get-Content -LiteralPath $Reservation.configPath -Raw | ConvertFrom-Json
                Invoke-RestMethod -Uri ([Uri]::new([Uri]$Reservation.healthUri, '/admin/resume')) -Method Post -Headers @{ Authorization = 'Bearer ' + $config.controlToken } -TimeoutSec 5 | Out-Null
            }
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Existing owned processes did not settle; restart remains scheduled' }
        Start-Sleep -Milliseconds 1000
    } while ($true)
    AssertBridgeReservation $Reservation
    $runtimeState = BridgeRuntimeState $Reservation
    if ($runtimeState -eq 'mixed') {
        BridgePhase $Reservation $State 'recovering_verified_original_files'
        InvokeBridgeInstaller $Reservation 'Rollback'
        $runtimeState = BridgeRuntimeState $Reservation
    }
    if ($runtimeState -notin @('original', 'candidate')) { throw 'Runtime is not a complete reviewed version; recovery receipt retained' }
    if (@(BridgeProcesses $Reservation).Count -gt 0 -or (BridgeInstallerActive $Reservation)) { throw 'Owner appeared before restart; do not start a duplicate' }
    BridgePhase $Reservation $State 'starting_launcher'
    $started = Start-Process -FilePath $Reservation.launcherPath -ArgumentList $Reservation.launcherArguments -WindowStyle Hidden -PassThru
    $State.launcherStarts++
    $State.startedPid = $started.Id
    $State.runtimeStateAtRestart = $runtimeState
    BridgePhase $Reservation $State 'waiting_for_daemon_health'
    $deadline = [DateTime]::UtcNow.AddSeconds(150)
    do {
        try {
            $health = Invoke-RestMethod -Uri $Reservation.healthUri -TimeoutSec 2
            $active = @(BridgeProcesses $Reservation)
            if ($health.status -eq 'ok' -and $health.service -eq 'codex-chatgpt-web' -and $health.accepting_turns -eq $true -and
                @($active | Where-Object { $_.pid -eq $health.pid }).Count -eq 1) {
                $State.daemonPid = $health.pid
                $State.healthyAt = [DateTime]::UtcNow.ToString('o')
                BridgePhase $Reservation $State 'launcher_healthy'
                return
            }
        } catch { }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Launcher was started, but accepting daemon health is not confirmed' }
        Start-Sleep -Milliseconds 1000
    } while ($true)
}
function InvokeReservedBridgeMaintenance($Reservation) {
    AssertBridgeReservation $Reservation
    $armedPath = Join-Path ([IO.Path]::GetDirectoryName($Reservation.statePath)) 'armed.json'
    if (-not (Test-Path -LiteralPath $armedPath)) { throw 'Verified reservation receipt is missing; no quit is allowed' }
    $armed = Get-Content -LiteralPath $armedPath -Raw | ConvertFrom-Json -DateKind String
    if ((BridgeFileHash $armed.manifestPath) -ne $armed.manifestSha256) { throw 'Armed manifest changed' }
    if ($armed.backend -eq 'task_scheduler') {
        $task = Get-ScheduledTask -TaskName $Reservation.taskName -ErrorAction Stop
        if ($task.Actions[0].Execute -ne $Reservation.powershellPath -or $task.Actions[0].Arguments -notlike ('* -ReservationSha256 ' + $armed.manifestSha256)) { throw 'Scheduled restart action changed' }
    } elseif ($armed.backend -eq 'independent_guardian') {
        $guardian = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $armed.guardianPid)
        $ready = Get-Content -LiteralPath (Join-Path (BridgeReservationDirectory $Reservation) 'guardian-ready.json') -Raw | ConvertFrom-Json -DateKind String
        if (-not $guardian -or $guardian.ExecutablePath -ne $Reservation.powershellPath -or $guardian.CreationDate.ToUniversalTime().ToString('o') -ne $armed.guardianCreatedAt -or
            $guardian.CommandLine -notmatch '-Action Supervise' -or $guardian.CommandLine -notlike ('*' + $armed.manifestSha256) -or
            $ready.pid -ne $armed.guardianPid -or $ready.manifestSha256 -ne $armed.manifestSha256) { throw 'Independent restart guardian is not ready' }
    } else { throw 'Unrecognized restart reservation backend' }
    $lock = [IO.File]::Open($Reservation.lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $State = Get-Content -LiteralPath $Reservation.statePath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
        if ($State.phase -in @('complete', 'reservation_probe_complete')) {
            CompleteBridgeReservation $Reservation
            return
        }
        $State.workerPid = $PID
        $State.workerStartedAt = [DateTime]::UtcNow.ToString('o')
        $State.runAttempts = 1 + [int]$State.runAttempts
        if ($Reservation.operation -eq 'Probe') {
            BridgePhase $Reservation $State 'reservation_probe_complete'
            CompleteBridgeReservation $Reservation
            return
        }
        $initial = $State.phase -eq 'prepared'
        $operationError = $null
        try {
            if ($initial) {
                RequestBridgeQuit $Reservation $State
                WaitBridgeIdle $Reservation
                BridgePhase $Reservation $State 'owned_exit_observed'
                if ($Reservation.operation -ne 'Restart') {
                    $State.installerInvocations++
                    BridgePhase $Reservation $State 'installer_requested'
                    InvokeBridgeInstaller $Reservation $Reservation.operation
                    $expectedState = if ($Reservation.operation -eq 'Install') { 'candidate' } else { 'original' }
                    if ((BridgeRuntimeState $Reservation) -ne $expectedState) { throw 'Post-install runtime state did not verify' }
                }
                $State.operationSucceeded = $true
            }
        } catch {
            $operationError = $_.Exception.Message
            $State.operationError = $operationError
            BridgePhase $Reservation $State 'operation_failed_recovery_pending'
        } finally {
            # Runs even on installer failure. A scheduler retry resumes here rather
            # than repeating the quit, user sends, or the original installation.
            RestoreBridgeLauncher $Reservation $State
        }
        $State.recoveredAfterFailure = [bool]($operationError -or $State.operationError)
        BridgePhase $Reservation $State 'complete'
        CompleteBridgeReservation $Reservation
    } catch {
        if ($State) {
            $State.recoveryError = $_.Exception.Message
            BridgePhase $Reservation $State 'recovery_failed_scheduled_retry'
        }
        throw
    } finally { $lock.Dispose() }
}
function NewBridgeMaintenanceReservation([string]$RequestedOperation, [string]$ReviewedPlanPath, [string]$ReviewedPlanHash, [string]$ReviewedInstallerPath, [string]$ReviewedInstallerHash, [bool]$AllowActive = $false) {
    $runtimeRoot = 'C:\Users\Administrator\.codex-chatgpt-web'
    $launcherPath = 'C:\Users\Administrator\AppData\Local\Programs\Codex Web GPT\Codex Web GPT.exe'
    $powershellPath = 'C:\Program Files\PowerShell\7\pwsh.exe'
    $ReviewedPlanPath = (Resolve-Path -LiteralPath $ReviewedPlanPath).Path
    if ($ReviewedPlanHash -notmatch '^[a-f0-9]{64}$' -or (BridgeFileHash $ReviewedPlanPath) -ne $ReviewedPlanHash) { throw 'Reviewed plan hash is required' }
    $plan = Get-Content -LiteralPath $ReviewedPlanPath -Raw | ConvertFrom-Json
    if ($plan.schemaVersion -ne 1 -or $plan.files.Count -ne 7) { throw 'Unexpected seven-file overlay plan' }
    $targets = @('C:\Users\Administrator\AppData\Local\Programs\Codex Web GPT\resources\app.asar')
    foreach ($root in @((Join-Path $runtimeRoot 'versions/6.1.4-win32-x64'), 'C:\Users\Administrator\AppData\Local\Programs\Codex Web GPT\resources\runtime')) {
        foreach ($relative in @('app/cli.js', 'app/browser-helper.cjs', 'manifest.json')) { $targets += [IO.Path]::GetFullPath((Join-Path $root $relative)) }
    }
    foreach ($file in $plan.files) {
        if ([IO.Path]::GetFullPath($file.target) -notin $targets) { throw 'Plan target is not an exact reviewed bridge file' }
        $targets = @($targets | Where-Object { $_ -ne [IO.Path]::GetFullPath($file.target) })
        if ($file.originalSha256 -notmatch '^[a-f0-9]{64}$' -or $file.candidateSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid target hash' }
    }
    $ReviewedInstallerPath = (Resolve-Path -LiteralPath $ReviewedInstallerPath).Path
    if ($ReviewedInstallerHash -notmatch '^[a-f0-9]{64}$' -or (BridgeFileHash $ReviewedInstallerPath) -ne $ReviewedInstallerHash) { throw 'Reviewed installer hash is required, including for recovery' }
    $descriptorPath = Join-Path $runtimeRoot 'runtime/launcher-browser.json'
    $configPath = Join-Path $runtimeRoot 'config.json'
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    if ($config.host -ne '127.0.0.1') { throw 'Expected local bridge configuration' }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $descriptor.pid)
    if (-not $owner -or $owner.ExecutablePath -ne $launcherPath) { throw 'Live launcher ownership could not be verified' }
    $healthUri = 'http://127.0.0.1:' + $config.port + '/healthz'
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 5
    if ($health.status -ne 'ok' -or ($RequestedOperation -ne 'Probe' -and $health.active_browser_turns -ne 0 -and -not $AllowActive)) { throw 'Bridge is not in a reviewed idle browser window' }
    $id = [Guid]::NewGuid().ToString('N')
    $directory = Join-Path $runtimeRoot ('runtime/restart-reservations/' + $id)
    $prefix = if ($RequestedOperation -eq 'Probe') { 'RestartProbe' } else { 'Maintenance' }
    $reservation = [ordered]@{
        schemaVersion = 1; taskName = 'CodexWebGPT-' + $prefix + '-' + $id; operation = $RequestedOperation
        powershellPath = $powershellPath; workerPath = Join-Path $directory 'worker.ps1'; workerSha256 = $null
        statePath = Join-Path $directory 'state.json'; lockPath = Join-Path $runtimeRoot 'runtime/bridge-maintenance.lock'
        launcherPath = $launcherPath; launcherSha256 = BridgeFileHash $launcherPath; launcherArguments = @('--hidden')
        executableRoot = [IO.Path]::GetDirectoryName($launcherPath) + '\'; runtimeRoot = $runtimeRoot
        runtimeCommandPattern = '(?i)(?:\bserve\b|browser-helper|launcher[\\/]electron)'
        planPath = $ReviewedPlanPath; planSha256 = $ReviewedPlanHash; files = $plan.files
        installerPath = $ReviewedInstallerPath; installerSha256 = $ReviewedInstallerHash
        healthUri = $healthUri; configPath = $configPath; descriptorPath = $descriptorPath
        priorLauncherPid = $owner.ProcessId; priorLauncherCreatedAt = $owner.CreationDate.ToUniversalTime().ToString('o'); priorDaemonPid = $health.pid
        allowActiveBrowserTurns = $AllowActive; browserTurnsAtReservation = $health.active_browser_turns
        rawRuntimeTokensRetained = 0
    }
    $state = BridgeRuntimeState $reservation
    if ($state -notin @('original', 'candidate')) { throw 'Current runtime is not a complete reviewed version' }
    if ($RequestedOperation -eq 'Install' -and $state -ne 'original') { throw 'Overlay is already installed; do not repeat its deployment' }
    return $reservation
}

if ($MyInvocation.InvocationName -eq '.') { return }
try {
    if ($Action -in @('Run', 'Supervise')) {
        if ($ReservationSha256 -notmatch '^[a-f0-9]{64}$' -or (BridgeFileHash $ReservationPath) -ne $ReservationSha256) { throw 'Reservation manifest changed' }
        $reservation = Get-Content -LiteralPath $ReservationPath -Raw | ConvertFrom-Json -DateKind String
        if ($Action -eq 'Supervise') { InvokeBridgeRestartGuardian $reservation $ReservationPath $ReservationSha256 }
        else { InvokeReservedBridgeMaintenance $reservation }
    } else {
        if ($Action -eq 'Reserve' -and -not $ShutdownAuthorized) { throw 'Reserve requires an authorized launcher shutdown window (-ShutdownAuthorized)' }
        if ($Action -eq 'Reserve' -and @(Get-ScheduledTask -TaskName 'CodexWebGPT-Maintenance-*' -ErrorAction SilentlyContinue).Count -gt 0) { throw 'A launcher maintenance reservation already exists; inspect its receipt first' }
        $requested = if ($Action -eq 'Probe') { 'Probe' } else { $Operation }
        $reservation = NewBridgeMaintenanceReservation $requested $PlanPath $PlanSha256 $InstallerPath $InstallerSha256 $AllowActiveBrowserTurns.IsPresent
        RegisterBridgeReservation $reservation $PSCommandPath | ConvertTo-Json -Depth 6
    }
} catch {
    if ($Action -in @('Run', 'Supervise') -and $reservation) {
        [IO.File]::WriteAllText((Join-Path (BridgeReservationDirectory $reservation) ($Action.ToLowerInvariant() + '-failure.log')), $_.Exception.Message)
    }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
