const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {freezeLegacy} = require('./freeze-legacy.cjs');
const {compileLegacyActions} = require('./legacy-actions.cjs');
function packagePrototype({sourceRoot, outputRoot, nativeExecutable, runtimeRoot, rendererRoot}) {
  outputRoot=path.resolve(outputRoot);
  if(fs.existsSync(outputRoot)&&fs.readdirSync(outputRoot).length)throw Error('Preserve existing prototype package');
  fs.mkdirSync(outputRoot,{recursive:true});
  const entries=[];
  const record=relative=>entries.push({path:relative,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(outputRoot,relative))).digest('hex')});
  const copy=(source,relative)=>{
    const target=path.resolve(outputRoot,relative);
    if(!target.startsWith(outputRoot+path.sep))throw Error('Prototype output outside package');
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
    record(relative);
  };
  const tree=(source,relative)=>{
    for(const entry of fs.readdirSync(source,{withFileTypes:true})){
      if(entry.isDirectory())tree(path.join(source,entry.name),path.join(relative,entry.name));
      else if(entry.isFile())copy(path.join(source,entry.name),path.join(relative,entry.name));
      else throw Error('Unexpected link in prototype renderer');
    }
  };
  copy(nativeExecutable,'CodexWebGPTNative.exe');
  copy(path.join(runtimeRoot,'runtime','bun.exe'),'backend/bun.exe');
  for(const file of ['entry.cjs','backend.cjs','host-client.cjs','native-platform.cjs','ui-bridge.cjs','legacy-actions.cjs','windows-services.cjs']){
    copy(path.join(sourceRoot,'launcher','native-webview2',file),'backend/'+file);
  }
  tree(rendererRoot,'backend/ui');
  const frozen=freezeLegacy(sourceRoot,path.join(outputRoot,'frozen'));
  tree(frozen.legacyRoot,'backend/legacy');
  fs.writeFileSync(path.join(outputRoot,'backend','legacy','native-action-source.json'),JSON.stringify(compileLegacyActions(frozen.legacyRoot)));
  record('backend/legacy/native-action-source.json');
  const manifest={prototypeOnly:true,defaultProfile:'development',runtimeVersion:'6.1.4',runtimeRoot:path.resolve(runtimeRoot),sourceRevision:frozen.manifest.revision};
  fs.writeFileSync(path.join(outputRoot,'backend','package.json'),JSON.stringify(manifest,null,2));
  record('backend/package.json');
  fs.writeFileSync(path.join(outputRoot,'Launch-Prototype.ps1'),`$ErrorActionPreference = 'Stop'\n$prototypeProfile = Join-Path $PSScriptRoot 'profile'\n$env:CODEX_WEB_GPT_DEV_HOME = $prototypeProfile\n& (Join-Path $PSScriptRoot 'CodexWebGPTNative.exe') --dev-profile --offline\n`);
  record('Launch-Prototype.ps1');
  fs.writeFileSync(path.join(outputRoot,'README.txt'),'Local Win32 + WebView2 prototype. Run Launch-Prototype.ps1 for the existing menus in an isolated DEV profile, with runtime startup disabled.\nUses installed WebView2 and the frozen runtimeRoot listed in backend/package.json. No production installation, update feed, guardian, login migration, live ChatGPT/Native2 parity or memory-leak certification.\n');
  record('README.txt');
  const result={at:new Date().toISOString(),packageRoot:outputRoot,executable:path.join(outputRoot,'CodexWebGPTNative.exe'),
    sourceRevision:frozen.manifest.revision,legacyManifest:frozen.manifest,files:entries,runtimeDependency:manifest.runtimeRoot,
    defaultProfile:'development',productionInstalled:false,portableRelease:false};
  fs.writeFileSync(path.join(outputRoot,'prototype-package.json'),JSON.stringify(result,null,2));
  return result;
}
module.exports={packagePrototype};
