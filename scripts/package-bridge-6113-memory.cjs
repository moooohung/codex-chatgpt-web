const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const workspace = process.cwd();
const id = 'bridge-6113-memory-20261021';
const home = 'C:/Users/Administrator/.codex-chatgpt-web';
const output = path.resolve(home, 'builds', id);
const installed = path.resolve('C:/Users/Administrator/AppData/Local/Programs/Codex Web GPT');
const oldRoot = path.resolve(home, 'versions/6.1.4-win32-x64');
const fixture = path.resolve(workspace, 'scratch/install-fixture-6113-memory');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, value) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, JSON.stringify(value, null, 2)+'\n'); };
const copy = (source, target) => { fs.mkdirSync(path.dirname(target), {recursive:true}); fs.copyFileSync(source, target); };
function files(root) { return fs.readdirSync(root, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? files(path.join(root, entry.name)) : [path.join(root, entry.name)]); }
const identity = p => ({path:p, sha256:hash(p)});
const record = (target, source, backupRelativePath) => ({target, source, backupRelativePath,
  originalSha256:fs.existsSync(target)?hash(target):null, candidateSha256:hash(source)});
const planPath = path.join(output, 'install-plan.json');
if (['package','seal'].includes(process.argv[2])) {
  if(fs.existsSync(planPath)) throw Error('Preserve existing sealed package');
  const staging = path.join(workspace, 'scratch/6113-memory-package');
  if(!fs.existsSync(path.join(staging, 'win-unpacked/resources/runtime/manifest.json'))) throw Error('Complete package is required');
  fs.mkdirSync(output, {recursive:true});
  if(process.argv[2] === 'package') fs.cpSync(staging, path.join(output, 'package'), {recursive:true, errorOnExist:true, force:false});
  const unpacked = path.join(output, 'package/win-unpacked');
  if(process.argv[2] === 'package') fs.cpSync(path.join(unpacked, 'resources/runtime'), path.join(output, 'runtime-final'), {recursive:true, errorOnExist:true, force:false});
  // A failed unsealed packaging attempt may resume only after complete source/copy hash comparison.
  for(const [from,to] of [[staging,path.join(output,'package')],[path.join(unpacked,'resources/runtime'),path.join(output,'runtime-final')]]) {
    const originalFiles=files(from).map(p=>path.relative(from,p)).sort();
    const copiedFiles=files(to).map(p=>path.relative(to,p)).sort();
    if(JSON.stringify(originalFiles)!==JSON.stringify(copiedFiles))throw Error('Candidate copy membership differs');
    for(const r of originalFiles)if(hash(path.join(from,r))!==hash(path.join(to,r)))throw Error('Candidate copy differs: '+r);
  }
  copy(path.join(unpacked, 'resources/app.asar'), path.join(output, 'app.asar'));
  copy(path.join(workspace, 'scripts/install-bridge-6113-memory.ps1'), path.join(output, 'install-reviewed.ps1'));
  copy(path.join(home, 'builds/bridge-6110-integrated-20261018/validate-bundle.cjs'), path.join(output, 'validate-bundle.cjs'));
  // Bundle the complete reviewed validator closure so the sealed module has no unhashed relative requires.
  cp.execFileSync('bun',['build','./launcher/electron/runtime-install.cjs','--target=node','--format=cjs',
    '--outfile='+path.join(output,'validation/runtime-install.cjs')],{stdio:'inherit'});
  const runtime = path.join(output, 'runtime-final'), targetRuntime = path.join(installed, 'resources/runtime');
  const manifest = json(path.join(runtime, 'manifest.json')), original = json(path.join(targetRuntime, 'manifest.json'));
  const watched = [record(path.join(installed, 'resources/app.asar'), path.join(output,'app.asar'),'resources/app.asar')];
  for(const relative of ['app/cli.js','app/browser-helper.cjs','manifest.json']) {
    const oldSource = path.join(output, 'old-watch', relative);
    copy(path.join(oldRoot, relative), oldSource);
    watched.push(record(path.join(oldRoot, relative), oldSource, 'old-watch/'+relative));
    watched.push(record(path.join(targetRuntime, relative), path.join(runtime, relative), 'resources/runtime/'+relative));
  }
  const launcherFiles = files(unpacked).map(p => [p,path.relative(unpacked,p)]).filter(([,r])=>r !== 'resources\\app.asar' && !r.startsWith('resources\\runtime\\'))
    .map(([source,r])=>record(path.join(installed,r), source, 'engine/'+r.replaceAll('\\','/')));
  const executable = path.resolve('C:/Program Files/nodejs/node.exe');
  const plan = {schemaVersion:1,id,operation:'full-launcher-upgrade',createdAt:new Date().toISOString(),packageRoot:output,
    backupRoot:path.resolve(home,'backups',id), sourceCommit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    upstreamTag:'v6.1.13',upstreamCommit:cp.execFileSync('git',['rev-parse','v6.1.13^{commit}'],{encoding:'utf8'}).trim(),
    bundleId:manifest.bundleId, files:watched, launcherFiles, electronVersion:'44.9.0',
    runtimeBundle:{source:runtime,target:targetRuntime,version:manifest.appVersion,platform:manifest.platform,arch:manifest.arch,
      bundleId:manifest.bundleId,manifestSha256:hash(path.join(runtime,'manifest.json')),fileCount:manifest.files.length,
      originalVersion:original.appVersion,originalBundleId:original.bundleId,originalManifestSha256:hash(path.join(targetRuntime,'manifest.json'))},
    runtimeCache:{path:path.resolve(home,'versions/6.1.13-win32-x64'),updatedBy:'ensurePackagedRuntime after guardian relaunch; not changed by candidate preparation'},
    validationScript:identity(path.join(output,'validate-bundle.cjs')),validationModule:identity(path.join(output,'validation/runtime-install.cjs')),
    validationExecutable:identity(executable),installerScript:identity(path.join(output,'install-reviewed.ps1')),
    nsisInstaller:identity(path.join(output,'package/codex-web-gpt-6.1.13-win-x64.exe')),
    maintenanceScript:identity(path.join(workspace,'scripts/schedule-bridge-maintenance.ps1')),
    validationProvenance:{buildCommand:'bun build ./launcher/electron/runtime-install.cjs --target=node --format=cjs',
      sources:['runtime-install.cjs','runtime-command.cjs','atomic-file.cjs'].map(r=>identity(path.join(workspace,'launcher/electron',r)))},
    readOnlyDependencies:[{target:path.join(installed,'resources/app.asar.unpacked/assets/linux-appimage-runner.sh'),sha256:hash(path.join(installed,'resources/app.asar.unpacked/assets/linux-appimage-runner.sh'))}],
    stopBeforeInstalling:true,providerPromptsSent:0};
  require(path.join(output,'validation/runtime-install.cjs')).validateRuntimeBundle(runtime,{version:'6.1.13',platform:'win32',arch:'x64',bundleId:manifest.bundleId});
  require(path.join(output,'validation/runtime-install.cjs')).validateRuntimeBundle(targetRuntime,{version:original.appVersion,platform:'win32',arch:'x64',bundleId:original.bundleId});
  write(planPath,plan);
  write(path.join(output,'artifact-hashes.json'),{sourceCommit:plan.sourceCommit,bundleId:plan.bundleId,plan:identity(planPath),
    installer:plan.nsisInstaller,installerScript:plan.installerScript,validationScript:plan.validationScript,
    validationModule:plan.validationModule,validationExecutable:plan.validationExecutable,
    runtimeManifest:identity(path.join(runtime,'manifest.json')),archive:identity(path.join(output,'app.asar'))});
  console.log(JSON.stringify({packageRoot:output,bundleId:manifest.bundleId,fileCount:manifest.files.length,launcherFiles:launcherFiles.length,planSha256:hash(planPath)}));
} else if (process.argv[2] === 'fixture') {
  const plan = json(planPath);
  if(fs.existsSync(fixture)) throw Error('Preserve existing fixture');
  const fixtureLauncher=path.join(fixture,'launcher'), fixtureOld=path.join(fixture,'core/versions/6.1.4-win32-x64');
  fs.mkdirSync(fixtureLauncher,{recursive:true});
  fs.cpSync(path.join(installed,'resources/runtime'),path.join(fixtureLauncher,'resources/runtime'),{recursive:true});
  copy(path.join(installed,'resources/app.asar'),path.join(fixtureLauncher,'resources/app.asar'));
  for(const r of ['app/cli.js','app/browser-helper.cjs','manifest.json'])copy(path.join(oldRoot,r),path.join(fixtureOld,r));
  for(const item of plan.launcherFiles)if(fs.existsSync(item.target))copy(item.target,path.join(fixtureLauncher,path.relative(installed,item.target)));
  // Three inert fixture originals deliberately differ so partial engine rollback actually executes.
  const different = plan.launcherFiles.filter(item=>!item.target.endsWith('.exe') && fs.statSync(item.source).size < 1000000).slice(0,3);
  if(different.length!==3)throw Error('Three inert engine files required');
  for(const item of different)fs.appendFileSync(path.join(fixtureLauncher,path.relative(installed,item.target)),'\nowned offline rollback fixture\n');
  const clone = structuredClone(plan);
  const remap = p => p.startsWith(installed+path.sep)?path.join(fixtureLauncher,path.relative(installed,p)):
    p.startsWith(oldRoot+path.sep)?path.join(fixtureOld,path.relative(oldRoot,p)):(()=>{throw Error('Unreviewed fixture mapping')})();
  clone.backupRoot=path.join(fixture,'backup');clone.runtimeBundle.target=path.join(fixtureLauncher,'resources/runtime');
  for(const item of [...clone.files,...clone.launcherFiles]){ item.target=remap(item.target);item.originalSha256=fs.existsSync(item.target)?hash(item.target):null; }
  clone.readOnlyDependencies=clone.readOnlyDependencies.map(item=>({target:remap(item.target),sha256:hash(remap(item.target))}));
  clone.fixtureOnly={root:fixture,modifiedOriginalEngineFiles:different.map(item=>path.relative(installed,item.target))};
  write(path.join(output,'fixture-plan.json'),clone);
  console.log(JSON.stringify({fixtureRoot:fixture,modifiedEngineOriginals:clone.fixtureOnly.modifiedOriginalEngineFiles}));
} else if(process.argv[2] === 'verify-fixture') {
  const plan = json(path.join(output,'fixture-plan.json'));
  const mode = process.argv[3];if(!['original','candidate'].includes(mode))throw Error('Verification mode required');
  let verified=0;
  for(const item of [...plan.files,...plan.launcherFiles]){const expected=item[mode+'Sha256'];const actual=fs.existsSync(item.target)?hash(item.target):null;if(actual!==expected)throw Error('Fixture hash mismatch: '+path.relative(fixture,item.target));verified++;}
  require(plan.validationModule.path).validateRuntimeBundle(plan.runtimeBundle.target,{version:mode==='original'?plan.runtimeBundle.originalVersion:'6.1.13',platform:'win32',arch:'x64',bundleId:mode==='original'?plan.runtimeBundle.originalBundleId:plan.bundleId});
  console.log(JSON.stringify({mode,hashesVerified:verified,completeRuntimeVerified:true,fixtureOnly:true}));
} else if(process.argv[2] === 'verify-live') {
  const plan=json(planPath);let verified=0;
  for(const item of [...plan.files,...plan.launcherFiles]) {
    const actual=fs.existsSync(item.target)?hash(item.target):null;
    if(actual!==item.originalSha256)throw Error('Live original drift: '+path.basename(item.target));
    verified++;
  }
  for(const item of plan.readOnlyDependencies)if(hash(item.target)!==item.sha256)throw Error('Live read-only dependency drift');
  require(plan.validationModule.path).validateRuntimeBundle(plan.runtimeBundle.target,{
    version:plan.runtimeBundle.originalVersion,platform:'win32',arch:'x64',bundleId:plan.runtimeBundle.originalBundleId});
  console.log(JSON.stringify({at:new Date().toISOString(),hashesVerified:verified,completeRuntimeFiles:json(path.join(plan.runtimeBundle.target,'manifest.json')).files.length,
    bundleId:plan.runtimeBundle.originalBundleId,readOnlyDependenciesVerified:plan.readOnlyDependencies.length,liveFilesChanged:0,providerPromptsSent:0}));
} else throw Error('Expected package, seal, fixture, verify-fixture or verify-live');
