const fs=require('node:fs'),path=require('node:path');
const {NativeHostClient}=require('./host-client.cjs');
const {startNativeLauncher}=require('./backend.cjs');
const args=process.argv,argument=name=>args[args.indexOf(name)+1];
async function main() {
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8'));
  const nativeExecutable=argument('--native-executable'),userDataFolder=argument('--user-data-folder');
  if(!nativeExecutable||!userDataFolder||!path.isAbsolute(nativeExecutable)||!path.isAbsolute(userDataFolder))throw new Error('Native parent paths are missing');
  const client=await NativeHostClient.attach({executable:nativeExecutable,userDataFolder});
  const userData=path.dirname(userDataFolder),coreHome=process.env.CODEX_CHATGPT_WEB_HOME||path.join(require('node:os').homedir(),'.codex-chatgpt-web');
  const load=require('node:module').createRequire(path.join(__dirname,'legacy','main.cjs'));
  const profile=load('./profile.cjs').resolveLauncherProfile({appData:process.env.APPDATA,env:{...process.env,CODEX_WEB_GPT_LAUNCHER_DATA_DIR:userData,CODEX_CHATGPT_WEB_HOME:coreHome}});
  const application=await startNativeLauncher({nativeExecutable,attachedClient:client,legacyRoot:path.join(__dirname,'legacy'),rendererRoot:path.join(__dirname,'ui'),runtimeRoot:manifest.runtimeRoot,profile,version:manifest.runtimeVersion,
    hidden:args.includes('--hidden'),startRuntime:!args.includes('--offline')});
  fs.writeFileSync(path.join(profile.userData,'native-launcher-health.json'),JSON.stringify({at:new Date().toISOString(),hostPid:client.pid,backendPid:process.pid,ready:true,descriptorPath:application.descriptorPath,actionCount:application.actions.actionCount}));
  process.once('SIGTERM',()=>{void application.close();});
}
main().catch(error=>{process.stderr.write('Native launcher startup failed: '+error.message+'\n');process.exitCode=1;});
