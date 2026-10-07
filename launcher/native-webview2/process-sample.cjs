const {execFileSync}=require('node:child_process');

// Only explicit PIDs from the isolated host/CDP session enter the shell command.
function processSample(pids) {
  if(!pids.length||pids.some(pid=>!Number.isInteger(pid)||pid<1))throw Error('Invalid owned PID list');
  const code='$nativeRows = @(); foreach ($nativeId in @('+[...new Set(pids)].join(',')+')) { $nativeProcess = Get-Process -Id $nativeId -ErrorAction SilentlyContinue; if ($nativeProcess) { $nativeRows += @{pid=$nativeId;privateBytes=$nativeProcess.PrivateMemorySize64;workingSetBytes=$nativeProcess.WorkingSet64;cpuSeconds=$nativeProcess.TotalProcessorTime.TotalSeconds} } }; ConvertTo-Json -InputObject @{at=[DateTime]::UtcNow.ToString("o");rows=$nativeRows} -Depth 4 -Compress';
  return JSON.parse(execFileSync('C:/Program Files/PowerShell/7/pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}));
}
module.exports={processSample};
