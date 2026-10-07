param([string]$OutputRoot = 'C:/Users/Administrator/.codex-chatgpt-web/builds/native-webview2-20261007-01a1119c')
$ErrorActionPreference = 'Stop'
$nativeSdkVersion = '1.0.4258.31'
$nativeSdkRoot = Join-Path $OutputRoot ('sdk/' + $nativeSdkVersion)
$nativeArchive = Join-Path $OutputRoot ('microsoft.web.webview2.' + $nativeSdkVersion + '.nupkg')
$nativeBaseUri = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + $nativeSdkVersion + '/microsoft.web.webview2.' + $nativeSdkVersion + '.nupkg'
[IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $nativeSdkRoot 'build/native/include/WebView2.h'))) {
    if (-not (Test-Path -LiteralPath $nativeArchive)) { Invoke-WebRequest -Uri $nativeBaseUri -OutFile $nativeArchive -TimeoutSec 60 }
    & dotnet nuget verify $nativeArchive --all --verbosity minimal
    if ($LASTEXITCODE -ne 0) { throw 'NuGet SDK signature verification failed' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($nativeArchive, $nativeSdkRoot)
    [IO.File]::WriteAllText((Join-Path $OutputRoot 'sdk-restore.json'), (@{at=[DateTime]::UtcNow.ToString('o');version=$nativeSdkVersion;source=$nativeBaseUri;sha256=(Get-FileHash -LiteralPath $nativeArchive -Algorithm SHA256).Hash.ToLowerInvariant();signatureVerified=$true} | ConvertTo-Json))
}
$nativeBuildRoot = Join-Path $OutputRoot 'cmake'
& cmake -S $PSScriptRoot -B $nativeBuildRoot -G 'Visual Studio 18 2026' -A x64 ('-DWEBVIEW2_SDK_ROOT=' + $nativeSdkRoot)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $nativeBuildRoot --config Release --parallel 2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$nativeExe = Join-Path $nativeBuildRoot 'Release/CodexWebGPTNative.exe'
[IO.File]::WriteAllText((Join-Path $OutputRoot 'build.json'), (@{at=[DateTime]::UtcNow.ToString('o');executable=$nativeExe;sha256=(Get-FileHash -LiteralPath $nativeExe -Algorithm SHA256).Hash.ToLowerInvariant();sdkVersion=$nativeSdkVersion;source=$PSScriptRoot} | ConvertTo-Json))
Write-Output ('NATIVE_HOST_BUILT ' + $nativeExe)
