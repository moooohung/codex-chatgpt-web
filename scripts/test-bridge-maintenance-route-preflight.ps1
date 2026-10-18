param(
    [string]$OutputDirectory,
    [string]$BunPath = 'C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT/resources/runtime/runtime/bun.exe',
    [string]$CliPath = 'C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT/resources/runtime/app/cli.js'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'schedule-bridge-maintenance.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('bridge-route-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$results = [Collections.Generic.List[string]]::new()
function AssertFixture($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function InputHashes($Reservation) {
    $items = @()
    foreach ($path in @((Join-Path $Reservation.routeCheck.codexHome 'config.toml'), (Join-Path $Reservation.runtimeRoot 'codex/integration-journal.json'), (Join-Path $Reservation.runtimeRoot 'codex/integration-journal.recovery.json'))) {
        $items += $(if (Test-Path -LiteralPath $path) { BridgeFileHash $path } else { 'absent' })
    }
    return $items -join ':'
}
function AssertRejected([string]$Name, $Reservation, [int]$Timeout = 15000) {
    $before = InputHashes $Reservation
    $rejected = $false
    try { AssertBridgeRoutePreflight $Reservation $Timeout | Out-Null } catch {
        $rejected = [bool]$_.Exception.Data['BridgeRoutePreflightRejected']
        AssertFixture ($_.Exception.Message -notmatch 'SYNTHETIC_SECRET_MUST_NOT_BE_LOGGED') 'Raw CLI diagnostic leaked into the failure receipt'
    }
    AssertFixture $rejected ($Name + ' was accepted')
    AssertFixture ((InputHashes $Reservation) -eq $before) ($Name + ' changed live fixture inputs')
    $results.Add($Name)
}
function SetJournal($Reservation, [scriptblock]$Change) {
    foreach ($name in @('integration-journal.json', 'integration-journal.recovery.json')) {
        $path = Join-Path $Reservation.runtimeRoot ('codex/' + $name)
        $journal = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
        & $Change $journal
        WriteBridgeJson $path $journal
    }
}
try {
    # Generate version-10 fixtures through the unmodified upstream integration
    # implementation, with private homes. No browser, auth or provider request.
    $generator = Join-Path $root 'generate.ts'
    $integrationImport = ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/codex-integration.ts')).Replace('\', '/') | ConvertTo-Json -Compress)
    $configImport = ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/config.ts')).Replace('\', '/') | ConvertTo-Json -Compress)
    [IO.File]::WriteAllText($generator, (@'
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {installCodexIntegration,deactivateCodexIntegration} from INTEGRATION_IMPORT;
import {defaultConfig} from CONFIG_IMPORT;
const root=process.argv[2];
// Match the durable executable identity used by the real CLI; only the homes
// below are disposable. No runtime is started by integration installation.
process.env.CODEX_CHATGPT_WEB_LAUNCHER=process.execPath;
process.env.CODEX_HOME=join(root,'codex-home');
process.env.CODEX_CHATGPT_WEB_HOME=join(root,'app');
mkdirSync(process.env.CODEX_HOME,{recursive:true});
writeFileSync(join(process.env.CODEX_HOME,'config.toml'),'model = "gpt-6.1-sol"\n');
const config=defaultConfig('browser-only');config.subagentProtocol='native';
installCodexIntegration(config);
if(process.argv[3]!=='active')deactivateCodexIntegration({forRuntimeRecovery:process.argv[3]==='recovery'});
'@).Replace('INTEGRATION_IMPORT', $integrationImport).Replace('CONFIG_IMPORT', $configImport))
    function Fixture([string]$Name, [string]$Mode = 'recovery') {
        $directory = Join-Path $root $Name
        & $BunPath $generator $directory $Mode
        if ($LASTEXITCODE -ne 0) { throw 'Offline fixture generation failed' }
        return [ordered]@{
            runtimeRoot = Join-Path $directory 'app'; healthUri = 'http://127.0.0.1:17841/healthz'
            statePath = Join-Path $directory 'state.json'
            routeCheck = @{ schemaVersion = 1; cliPath = $CliPath; cliSha256 = BridgeFileHash $CliPath; bunPath = $BunPath; bunSha256 = BridgeFileHash $BunPath; codexHome = Join-Path $directory 'codex-home' }
        }
    }
    foreach ($mode in @('active', 'disconnected', 'recovery')) {
        $reservation = Fixture ('valid-' + $mode) $mode
        $before = InputHashes $reservation
        $proof = AssertBridgeRoutePreflight $reservation
        AssertFixture ($proof.passed -and $proof.isolatedSnapshot -and $proof.active -eq ($mode -eq 'active') -and $proof.reconnectOnStartup -eq ($mode -eq 'recovery')) 'Valid route state was not proven'
        AssertFixture ((InputHashes $reservation) -eq $before) 'Successful preflight changed route inputs'
        $results.Add('valid_' + $mode + '_read_only')
    }
    $reservation = Fixture 'incident'
    $path = Join-Path $reservation.routeCheck.codexHome 'config.toml'
    [IO.File]::AppendAllText($path, "`nopenai_base_url = `"http://127.0.0.1:17841/v1`"`nexperimental_realtime_webrtc_call_base_url = `"https://chatgpt.com/backend-api/codex`"`n")
    AssertRejected 'inactive_journal_manual_bridge_lines_incident' $reservation
    $incident = $reservation

    $reservation = Fixture 'realtime-only'
    [IO.File]::AppendAllText((Join-Path $reservation.routeCheck.codexHome 'config.toml'), "`nexperimental_realtime_webrtc_call_base_url = `"https://chatgpt.com/backend-api/codex`"`n")
    AssertRejected 'inactive_realtime_only_drift' $reservation
    $reservation = Fixture 'foreign-route'
    [IO.File]::AppendAllText((Join-Path $reservation.routeCheck.codexHome 'config.toml'), "`nopenai_base_url = `"https://example.invalid/v1`"`n")
    AssertRejected 'foreign_route_preserved' $reservation
    $reservation = Fixture 'active-marker' 'active'
    $path = Join-Path $reservation.routeCheck.codexHome 'config.toml'
    [IO.File]::WriteAllText($path, ([IO.File]::ReadAllText($path) -replace '(?m)^# Managed by codex-chatgpt-web: Responses[^\r\n]*', '# changed marker'))
    AssertRejected 'active_marker_drift' $reservation
    $reservation = Fixture 'active-hook' 'active'
    $journal = Get-Content -LiteralPath (Join-Path $reservation.runtimeRoot 'codex/integration-journal.json') -Raw | ConvertFrom-Json
    $path = Join-Path $reservation.routeCheck.codexHome 'config.toml'
    [IO.File]::WriteAllText($path, ([IO.File]::ReadAllText($path).Replace($journal.interruptHook.trustedHash, 'sha256:' + ('0' * 64))))
    AssertRejected 'active_interrupt_hook_drift' $reservation
    $reservation = Fixture 'wrong-home'
    SetJournal $reservation { param($journal) $journal.configPath = Join-Path $root 'other/config.toml' }
    AssertRejected 'journal_target_mismatch' $reservation
    $reservation = Fixture 'malformed-journal'
    [IO.File]::WriteAllText((Join-Path $reservation.runtimeRoot 'codex/integration-journal.json'), '{malformed')
    AssertRejected 'malformed_journal_preserved' $reservation
    $reservation = Fixture 'missing-recovery'
    Remove-Item -LiteralPath (Join-Path $reservation.runtimeRoot 'codex/integration-journal.recovery.json')
    $before = InputHashes $reservation
    AssertBridgeRoutePreflight $reservation | Out-Null
    AssertFixture ((InputHashes $reservation) -eq $before) 'Status recreated a live recovery journal'
    $results.Add('upstream_journal_repair_confined_to_snapshot')
    $reservation = Fixture 'no-journals'
    Remove-Item -LiteralPath (Join-Path $reservation.runtimeRoot 'codex/integration-journal.json'), (Join-Path $reservation.runtimeRoot 'codex/integration-journal.recovery.json')
    AssertRejected 'missing_installation' $reservation

    # Process/output boundary checks use inert child commands rather than providers.
    $reservation = Fixture 'cli-boundaries'
    $fake = Join-Path $root 'inert-status.cjs'
    foreach ($case in @(
        @{ name = 'json_errors_with_exit_zero'; code = 'console.log(JSON.stringify({installed:true,active:false,errors:["SYNTHETIC_SECRET_MUST_NOT_BE_LOGGED"],routeUrl:"http://127.0.0.1:17841/v1"}));' },
        @{ name = 'nonzero_exit'; code = 'process.exit(3);' },
        @{ name = 'invalid_stdout'; code = 'console.log("not-json");' },
        @{ name = 'invalid_status_shape'; code = 'console.log(JSON.stringify({installed:1,active:false,errors:[]}));' },
        @{ name = 'wrong_endpoint'; code = 'console.log(JSON.stringify({installed:true,active:true,errors:[],routeUrl:"http://127.0.0.1:9999/v1"}));' },
        @{ name = 'bounded_timeout'; code = 'setTimeout(()=>{},20000);' }
    )) {
        [IO.File]::WriteAllText($fake, $case.code)
        $reservation.routeCheck.cliPath = $fake
        $reservation.routeCheck.cliSha256 = BridgeFileHash $fake
        AssertRejected $case.name $reservation $(if ($case.name -eq 'bounded_timeout') { 200 } else { 15000 })
    }
    $reservation.routeCheck.cliSha256 = '0' * 64
    AssertRejected 'checker_hash_drift' $reservation
    $reservation = Fixture 'concurrent-drift'
    $path = Join-Path $reservation.routeCheck.codexHome 'config.toml'
    $intentionalChange = [IO.File]::ReadAllText($path) + "`n# concurrent fixture writer`n"
    [IO.File]::WriteAllText($fake, ('require("node:fs").appendFileSync(' + ($path | ConvertTo-Json -Compress) + ',"\n# concurrent fixture writer\n");console.log(JSON.stringify({installed:true,active:false,errors:[],routeUrl:"http://127.0.0.1:17841/v1"}));'))
    $reservation.routeCheck.cliPath = $fake; $reservation.routeCheck.cliSha256 = BridgeFileHash $fake
    $rejected = $false
    try { AssertBridgeRoutePreflight $reservation | Out-Null } catch { $rejected = $_.Exception.Message -match 'Route changed during preflight' }
    AssertFixture ($rejected -and [IO.File]::ReadAllText($path) -eq $intentionalChange) 'Concurrent route writer was overwritten or not detected'
    $results.Add('concurrent_writer_detected_and_preserved')

    # Full worker state path: a preflight failure is terminal, leaves the healthy
    # owner alone and is never promoted to complete/healthy by recovery's finally.
    $directory = [IO.Path]::GetDirectoryName($incident.statePath)
    $planPath = Join-Path $directory 'plan.json'
    WriteBridgeJson $planPath @{}
    $incident.schemaVersion = 1
    $incident.taskName = 'CodexWebGPT-RestartFixture-' + [Guid]::NewGuid().ToString('N')
    $incident.operation = 'Install'
    $incident.workerPath = $PSCommandPath; $incident.workerSha256 = BridgeFileHash $PSCommandPath
    $incident.planPath = $planPath; $incident.planSha256 = BridgeFileHash $planPath
    $incident.launcherPath = $BunPath; $incident.launcherSha256 = BridgeFileHash $BunPath
    $incident.powershellPath = 'offline-fixture'; $incident.lockPath = Join-Path $directory 'worker.lock'
    $manifestPath = Join-Path $directory 'reservation.json'
    WriteBridgeJson $manifestPath $incident
    $manifestHash = BridgeFileHash $manifestPath
    WriteBridgeJson (Join-Path $directory 'armed.json') @{ backend = 'task_scheduler'; manifestPath = $manifestPath; manifestSha256 = $manifestHash }
    WriteBridgeJson $incident.statePath @{ phase = 'prepared'; shutdownRequested = $false; installerInvocations = 0; launcherStarts = 0; operationSucceeded = $false }
    function Get-ScheduledTask { return @{ Actions = @(@{ Execute = 'offline-fixture'; Arguments = ' -ReservationSha256 ' + $manifestHash }) } }
    function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) }
    function WaitBridgeMaintenanceWindow {}
    function RequestBridgeQuit($Reservation, $State) { ConfirmBridgeRouteBeforeQuit $Reservation $State; throw 'Preflight incorrectly allowed quit' }
    function RestoreBridgeLauncher { throw 'Rejected preflight incorrectly attempted launcher recovery' }
    function InvokeBridgeInstaller { throw 'Rejected preflight incorrectly attempted installation' }
    InvokeReservedBridgeMaintenance $incident
    InvokeReservedBridgeMaintenance $incident
    $state = Get-Content -LiteralPath $incident.statePath -Raw | ConvertFrom-Json
    AssertFixture ($state.phase -eq 'preflight_rejected' -and -not $state.shutdownRequested -and $state.installerInvocations -eq 0 -and $state.launcherStarts -eq 0 -and -not $state.operationSucceeded -and -not $state.healthyAt -and $state.runAttempts -eq 1) 'Rejected worker retried, restarted, installed or falsely completed'
    $results.Add('worker_terminal_rejection_no_restart_install_or_false_complete')
    $report = @{ passed = $true; cases = @($results); originalCliSha256 = BridgeFileHash $CliPath; originalBunSha256 = BridgeFileHash $BunPath; realQuitRequests = 0; realInstallations = 0; providerRequests = 0 }
    if ($OutputDirectory) { [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory)) | Out-Null; WriteBridgeJson (Join-Path $OutputDirectory 'maintenance-route-tests.json') $report }
    $report | ConvertTo-Json -Depth 6
} finally {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $target = [IO.Path]::GetFullPath($root)
    if (-not $target.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notmatch '^bridge-route-fixture-[a-f0-9]{32}$') { throw 'Unexpected fixture cleanup target' }
    Remove-Item -LiteralPath $target -Recurse -Force
}
