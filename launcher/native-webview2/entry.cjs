const fs=require('node:fs'),path=require('node:path');
const {NativeHostClient}=require('./host-client.cjs');
const {startNativeLauncher}=require('./backend.cjs');
const args=process.argv,argument=name=>args[args.indexOf(name)+1];
async function main() {
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8'));
  const nativeExecutable=argument('--native-executable'),userDataFolder=argument('--user-data-folder');
  if(!nativeExecutable||!userDataFolder||!path.isAbsolute(nativeExecutable)||!path.isAbsolute(userDataFolder))throw new Error('Native parent paths are missing');
  const client=await NativeHostClient.attach({executable:nativeExecutable,userDataFolder});
  try {
  const userData=path.dirname(userDataFolder);
  const load=require('node:module').createRequire(path.join(__dirname,'legacy','main.cjs'));
  // DEV resolution compares against the production profile. Do not replace that
  // comparison path with the parent's DEV directory before resolving the profile.
  const profileEnv=args.includes('--dev-profile')?process.env:{...process.env,CODEX_WEB_GPT_LAUNCHER_DATA_DIR:userData};
  const profile=load('./profile.cjs').resolveLauncherProfile({argv:args,appData:process.env.APPDATA,env:profileEnv});
  if(path.resolve(profile.userData).toLowerCase()!==path.resolve(userData).toLowerCase())throw new Error('Native parent and backend profile paths differ');
  const application=await startNativeLauncher({nativeExecutable,attachedClient:client,legacyRoot:path.join(__dirname,'legacy'),rendererRoot:path.join(__dirname,'ui'),runtimeRoot:manifest.runtimeRoot,profile,version:manifest.runtimeVersion,
    hidden:args.includes('--hidden'),startRuntime:!args.includes('--offline')});
  fs.writeFileSync(path.join(profile.userData,'native-launcher-health.json'),JSON.stringify({at:new Date().toISOString(),hostPid:client.pid,backendPid:process.pid,ready:true,profile:profile.kind,runtimeStarted:!args.includes('--offline'),descriptorPath:application.descriptorPath,actionCount:application.actions.actionCount,packagedActions:application.actions.packaged}));
  process.once('SIGTERM',()=>{void application.close();});
  void client.exited.then(async()=>{
    if(application.isClosing())return;
    try{await application.parentExited();}
    finally{process.exit(1);}
  }).catch(error=>{process.stderr.write('Native backend parent-exit cleanup failed: '+error.message+'\n');process.exit(1);});
  } catch(error) {
    await client.quit().catch(()=>{});
    process.stdin.destroy();
    throw error;
  }
}
main().catch(error=>{process.stderr.write('Native launcher startup failed: '+error.message+'\n');process.exitCode=1;});
