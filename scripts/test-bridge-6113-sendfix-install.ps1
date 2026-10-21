$ErrorActionPreference = 'Stop'
$candidate = 'C:/Users/Administrator/.codex-chatgpt-web/builds/bridge-6113-sendfix-20261021'
$fixture = 'C:/Users/Administrator/.codex-chatgpt-web/worktrees/integrate-6113-20261021/scratch/install-fixture-6113-sendfix'
$installer = Join-Path $candidate 'install-reviewed.ps1'
$fixturePlan = Join-Path $candidate 'fixture-plan.json'
$report = [Collections.Generic.List[object]]::new()
function Invoke-Fixture([string]$Label, [string]$Action, [string]$Injection = '') {
    $log = Join-Path $PWD ('scratch/6113-sendfix-fixture-' + $Label + '.log')
    $arguments = @('-NoProfile','-NonInteractive','-File',$installer,'-PlanPath',$fixturePlan,'-FixtureRoot',$fixture,'-Action',$Action)
    if ($Action -in @('Install','Rollback')) { $arguments += '-IdleWindowAuthorized' }
    if ($Injection) { $arguments += '-' + $Injection }
    & (Join-Path $PSHOME 'pwsh.exe') @arguments *> $log
    $code = $LASTEXITCODE
    if ($Injection) {
        if ($code -eq 0 -or (Get-Content -LiteralPath $log -Raw) -notmatch 'Injected fixture failure') { throw "Expected injection was not observed: $Label, exit $code" }
    } elseif ($code -ne 0) { throw "Fixture step failed: $Label, exit $code; $log" }
    $report.Add([pscustomobject]@{ step=$Label; action=$Action; exitCode=$code; expectedFailure=[bool]$Injection; log=$log })
    Write-Output ($Label + ': ' + $code)
}
function Verify-Fixture([string]$Label, [string]$Expected) {
    $log = Join-Path $PWD ('scratch/6113-sendfix-fixture-' + $Label + '-readback.json')
    & node 'scripts/package-bridge-6113-sendfix.cjs' verify-fixture $Expected > $log
    if ($LASTEXITCODE -ne 0) { throw "Fixture readback failed: $Label" }
    $proof = Get-Content -LiteralPath $log -Raw | ConvertFrom-Json
    $report.Add([pscustomobject]@{step=$Label+'-readback'; result=$proof; log=$log})
    Write-Output ($Label + ' readback: ' + $proof.hashesVerified + ' hashes and complete runtime')
}
Invoke-Fixture 'check' 'Check'
Invoke-Fixture 'prepare' 'Prepare'
Invoke-Fixture 'install' 'Install'
Verify-Fixture 'install' 'candidate'
Invoke-Fixture 'rollback' 'Rollback'
Verify-Fixture 'rollback' 'original'
foreach ($injection in @('FixtureFailAfterRuntime','FixtureFailDuringEngine','FixtureFailAfterEngine')) {
    Invoke-Fixture $injection 'Install' $injection
    Verify-Fixture $injection 'original'
}
$result = [ordered]@{at=[DateTime]::UtcNow.ToString('o');fixtureRoot=$fixture;fixtureOnly=$true;steps=$report;providerPromptsSent=0;liveInstallAttempted=$false}
[IO.File]::WriteAllText((Join-Path $PWD 'scratch/6113-sendfix-fixture-result.json'),($result | ConvertTo-Json -Depth 10))
Write-Output 'ALL_OFFLINE_FIXTURE_STEPS_PASSED'
