const { execFile }=require('node:child_process');
const encode=value=>Buffer.from(String(value),'utf8').toString('base64');
async function resolveWindowsProxy(url) {
  const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('Invalid proxy target');
  const script="$nativeUrl = [uri][Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encode(parsed.href)+"')); $nativeProxy = [System.Net.Http.HttpClient]::DefaultProxy; if ($nativeProxy.IsBypassed($nativeUrl)) { 'DIRECT' } else { $nativeAddress = $nativeProxy.GetProxy($nativeUrl); if ($nativeAddress -eq $nativeUrl) { 'DIRECT' } elseif ($nativeAddress.Scheme -eq 'http') { 'PROXY ' + $nativeAddress.Authority } elseif ($nativeAddress.Scheme -eq 'https') { 'HTTPS ' + $nativeAddress.Authority } else { throw 'Unsupported system proxy scheme' } }";
  return new Promise((accept,reject)=>execFile('C:/Program Files/PowerShell/7/pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:4096},(error,stdout)=>error?reject(new Error('Windows proxy resolution failed')):accept(stdout.trim())));
}
function nativeDialogs(client) {
  return {
    showMessageBox:(_window,options)=>client.request('confirm',[encode(options.title),encode(options.message),encode(options.detail||'')],600000),
    showSaveDialog:(_window,options)=>client.request('save',[encode(options.title),encode(options.defaultPath)],600000),
  };
}
module.exports={resolveWindowsProxy,nativeDialogs};
