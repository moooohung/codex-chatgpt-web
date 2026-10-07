param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'schedule-bridge-maintenance.ps1')
$directory = Join-Path ([IO.Path]::GetTempPath()) ('bridge-active-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$fixtureSource = Join-Path $directory 'fixture.ts'
$log = Join-Path $directory 'events.jsonl'
[IO.File]::WriteAllText($fixtureSource, @'
import { appendFileSync } from "node:fs";
const log=(event:string)=>appendFileSync(process.argv[3],JSON.stringify({event})+"\n");
let drainBad=false;
let browserTurns=2, httpTurns=3;
const server=Bun.serve({hostname:"127.0.0.1",port:Number(process.argv[2]),fetch(request,server){
 const url=new URL(request.url);
 if(url.pathname==="/devtools/browser/fixture") {server.upgrade(request);return;}
 if(url.pathname==="/json/version")return Response.json({webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/browser/fixture`});
 if(url.pathname==="/admin/drain") {log("drain");return Response.json({status:"ok",accepting_turns:drainBad,active_browser_turns:browserTurns,active_http_turns:httpTurns});}
 if(url.pathname==="/admin/resume") {log("resume");return Response.json({status:"ok"});}
 if(url.pathname==="/bad-drain") {drainBad=true;return Response.json({status:"ok"});}
 if(url.pathname==="/native-only") {browserTurns=0;return Response.json({status:"ok"});}
 if(url.pathname==="/browser-work") {browserTurns=2;return Response.json({status:"ok"});}
 if(url.pathname==="/shutdown") {setTimeout(()=>{server.stop(true);process.exit(0)},50);return Response.json({status:"stopping"});}
 return Response.json({status:"ok",pid:process.pid,active_browser_turns:browserTurns,active_http_turns:httpTurns,accepting_turns:true});
},websocket:{message(ws,message){if(JSON.parse(String(message)).method==="Browser.close")log("quit");},close(){}}});
setTimeout(()=>{server.stop(true);process.exit(0)},60_000);
'@)
$bun = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/bun.exe'
$fixture = Start-Process -FilePath $bun -ArgumentList @('"' + $fixtureSource + '"', [string]$port, '"' + $log + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log')
$uri = 'http://127.0.0.1:' + $port
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try { $health = Invoke-RestMethod -Uri ($uri + '/healthz') -TimeoutSec 1; break } catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 50 }
    } while ($true)
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $fixture.Id)
    $descriptor = Join-Path $directory 'descriptor.json'
    $config = Join-Path $directory 'config.json'
    WriteBridgeJson $descriptor @{ pid = $fixture.Id; endpoint = $uri }
    WriteBridgeJson $config @{ controlToken = 'offline-fixture' }
    $reservation = [ordered]@{ launcherPath = $owner.ExecutablePath; priorLauncherPid = $fixture.Id; priorLauncherCreatedAt = $owner.CreationDate.ToUniversalTime().ToString('o'); priorDaemonPid = $fixture.Id; healthUri = $uri + '/healthz'; descriptorPath = $descriptor; configPath = $config; statePath = Join-Path $directory 'state.json'; allowActiveBrowserTurns = $false }
    $state = [ordered]@{ phase = 'prepared'; shutdownRequested = $false; browserTurnsAtQuit = 0 }
    $rejected = $false
    try { RequestBridgeQuit $reservation $state } catch { $rejected = $_.Exception.Message -match 'browser work changed' }
    if (-not $rejected -or (Test-Path -LiteralPath $log)) { throw 'Default active-turn guard sent drain or quit' }
    Invoke-RestMethod -Uri ($uri + '/native-only') -TimeoutSec 1 | Out-Null
    $nativeRejected = $false
    try { RequestBridgeQuit $reservation $state } catch { $nativeRejected = $_.Exception.Message -match 'native HTTP turns' }
    if (-not $nativeRejected -or (Test-Path -LiteralPath $log)) { throw 'Native-only active work sent drain or quit' }
    Invoke-RestMethod -Uri ($uri + '/browser-work') -TimeoutSec 1 | Out-Null
    $reservation.allowActiveBrowserTurns = $true
    RequestBridgeQuit $reservation $state
    Start-Sleep -Milliseconds 150
    $events = Get-Content -LiteralPath $log
    if ($events.Count -ne 2 -or $events[0] -notmatch 'drain' -or $events[1] -notmatch 'quit' -or $state.browserTurnsAtQuit -ne 2 -or $state.httpTurnsAtQuit -ne 3) { throw 'Explicit active maintenance did not use normal quit with count receipt' }
    $reservation.priorDaemonPid = -1
    $ownerRejected = $false
    try { RequestBridgeQuit $reservation $state } catch { $ownerRejected = $_.Exception.Message -match 'daemon or browser work changed' }
    if (-not $ownerRejected -or @(Get-Content -LiteralPath $log).Count -ne 2) { throw 'Active option bypassed daemon ownership' }
    $reservation.priorDaemonPid = $fixture.Id
    Invoke-RestMethod -Uri ($uri + '/bad-drain') -TimeoutSec 1 | Out-Null
    $drainRejected = $false
    try { RequestBridgeQuit $reservation $state } catch { $drainRejected = $_.Exception.Message -match 'drain was not acknowledged' }
    $events = Get-Content -LiteralPath $log
    if (-not $drainRejected -or $events.Count -ne 4 -or $events[2] -notmatch 'drain' -or $events[3] -notmatch 'resume') { throw 'Unacknowledged drain did not resume before rejecting quit' }
    $report = @{ passed = $true; cases = @('default_busy_guard_no_writes','native_only_busy_guard_no_writes','explicit_active_normal_quit','daemon_owner_guard','unacknowledged_drain_resumes'); browserTurnsAtQuit = 2; httpTurnsAtQuit = 3; realLauncherQuitRequests = 0; fixtureRoot = $directory }
    if ($OutputDirectory) { [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory)) | Out-Null; WriteBridgeJson (Join-Path $OutputDirectory 'maintenance-active-tests.json') $report }
    $report | ConvertTo-Json -Depth 5
} finally {
    try { Invoke-RestMethod -Uri ($uri + '/shutdown') -TimeoutSec 1 | Out-Null } catch {}
    $fixture.WaitForExit(3000) | Out-Null
}
