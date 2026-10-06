import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";
import { memoryOverlay } from "./installed-memory-overlay";

const root = resolve(import.meta.dir, "..");
const [installedRuntimeArg, installedArchiveArg, destinationArg, expectedArg] = process.argv.slice(2);
if (!installedRuntimeArg || !installedArchiveArg || !destinationArg || !expectedArg) {
  throw new Error("Usage: stage-browser-memory.ts installed-runtime installed-app.asar output-directory expected-hashes.json");
}
const installedRuntime = resolve(installedRuntimeArg), installedArchive = resolve(installedArchiveArg), destination = resolve(destinationArg);
if (destination.startsWith(installedRuntime) || installedRuntime.startsWith(destination)
  || installedArchive.startsWith(destination) || destination.startsWith(dirname(installedArchive))) {
  throw new Error("Staging must be separate from installed resources");
}
const marker = join(destination, "packet-76-staging.json");
if (existsSync(destination) && !existsSync(marker)) throw new Error("Refusing an existing unowned staging directory");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const expected = JSON.parse(readFileSync(expectedArg, "utf8"));
const observedConfigurationDrift: any[] = [];
for (const file of expected.files) {
  const current = hash(readFileSync(file.path));
  if (current === file.sha256) continue;
  if (file.path.endsWith("config.json") || file.path.endsWith("config.toml")) {
    // Configurations are observations, not staging inputs. Never overwrite a concurrent edit.
    observedConfigurationDrift.push({path:file.path,before:file.sha256,current,cause:"unconfirmed",copiedOrModified:false});
    continue;
  }
  throw new Error(`Installed input changed since observation: ${file.path}`);
}
const require = createRequire(join(root, "launcher/package.json"));
const asar = require("@electron/asar");
const {validateRuntimeBundle} = require(join(root, "launcher/electron/runtime-install.cjs"));
const originalManifest = JSON.parse(readFileSync(join(installedRuntime, "manifest.json"), "utf8"));
const identity = {version: "6.1.4", platform: "win32", arch: "x64"};
validateRuntimeBundle(installedRuntime, identity);
mkdirSync(destination, {recursive: true});
writeFileSync(marker, JSON.stringify({packet:76, phase:"staging", sourceRoot:root}));
const runtime = join(destination, "runtime");
cpSync(installedRuntime, runtime, {recursive:true, verbatimSymlinks:true});
const overlays: any[] = [];

async function exerciseInstalledQueue(code: string, filename: string) {
  const parsed = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let queue: ts.ClassDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.getText(parsed).includes('"Invalid browser concurrency capacity"')) queue = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!queue?.name) throw new Error("Staged queue class cannot be inspected");
  const context = {process:{env:{}}, Promise, DOMException, AbortController, setInterval, clearInterval};
  const Queue = vm.runInNewContext(`${queue.getText(parsed)};${queue.name.text}`, context);
  const instance = new Queue();
  assert.equal(instance.capacity,4);
  const started: number[] = [], finish = new Map<number,()=>void>();
  const runs = Array.from({length:6},(_,id)=>instance.run(()=>new Promise<string>(resolve=>{
    started.push(id); finish.set(id,()=>resolve(String(id)));
  })));
  await Promise.resolve();
  assert.deepEqual(started,[0,1,2,3]);
  finish.get(0)!(); await runs[0]; await Promise.resolve();
  assert.deepEqual(started,[0,1,2,3,4]);
  finish.get(1)!(); await runs[1]; await Promise.resolve();
  assert.deepEqual(started,[0,1,2,3,4,5]);
  for(const id of [2,3,4,5])finish.get(id)!();
  await Promise.all(runs);
  assert.equal(instance.running,0);
  return {defaultCapacity:4, submitted:6, fifo:true, physicalSettlement:true};
}

for (const name of ["cli.js", "browser-helper.cjs"]) {
  const path = join(runtime,"app",name), original = readFileSync(path,"utf8");
  const overlay = memoryOverlay(original,name,name === "cli.js");
  const queueCheck = await exerciseInstalledQueue(overlay.code,name);
  writeFileSync(path,overlay.code);
  overlays.push({path:`app/${name}`, before:hash(original), after:hash(overlay.code), edits:overlay.edits, queueCheck});
}
const manifest = {...originalManifest,files:originalManifest.files.map((file:any)=>{
  const overlay=overlays.find(item=>item.path===file.path);
  return overlay ? {...file,sha256:overlay.after,size:readFileSync(join(runtime,file.path)).length} : file;
})};
const digest=createHash("sha256");
for(const file of manifest.files){digest.update(`${file.path}\0${file.size}\0${file.sha256}\0`);}
manifest.bundleId=digest.digest("hex");
writeFileSync(join(runtime,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
validateRuntimeBundle(runtime,identity);

const launcher=join(destination,"launcher-source");
mkdirSync(launcher,{recursive:true});
asar.extractAll(installedArchive,launcher);
const launcherChanges=["electron/main.cjs","electron/browser-host.cjs","electron/browser-memory-policy.cjs"];
for(const name of launcherChanges){
  if(name!=="electron/browser-memory-policy.cjs"){
    const baseline=execFileSync("git",["show",`8e2745b:launcher/${name}`],{cwd:root,encoding:"utf8"}).replace(/\r\n/g,"\n");
    const installed=readFileSync(join(launcher,name),"utf8").replace(/\r\n/g,"\n");
    if(baseline!==installed)throw new Error(`Unreconciled installed launcher changes: ${name}`);
  }
  cpSync(join(root,"launcher",name),join(launcher,name));
}
const archive=join(destination,"app.asar");
await asar.createPackageWithOptions(launcher,archive,{unpack:"assets/linux-appimage-runner.sh"});
const files=(file:string)=>asar.listPackage(file).map((name:string)=>name.replace(/^[/\\]+/,"").replaceAll("\\","/")).filter((name:string)=>!asar.statFile(file,name).files);
const beforeFiles=files(installedArchive),afterFiles=files(archive);
const archiveChanges=[];
for(const file of afterFiles){
  const previous=beforeFiles.includes(file)?hash(asar.extractFile(installedArchive,file)):null;
  const current=hash(asar.extractFile(archive,file));
  if(previous!==current)archiveChanges.push(file);
}
assert.deepEqual(archiveChanges.sort(),launcherChanges.sort());
assert.equal(beforeFiles.every((file:string)=>afterFiles.includes(file)),true);
const evidence={packet:76,phase:"verified_staging",createdAt:new Date().toISOString(),
  sourceRoot:root,sourceCommit:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),
  sourceDirty:execFileSync("git",["status","--porcelain"],{cwd:root,encoding:"utf8"}).trim(),
  runtime,archive,bundleId:manifest.bundleId,manifestSha256:hash(readFileSync(join(runtime,"manifest.json"))),
  archiveSha256:hash(readFileSync(archive)),baselineBundleId:originalManifest.bundleId,
  baselineArchiveSha256:hash(readFileSync(installedArchive)),overlays,archiveChanges,
  unchangedRuntimeFiles:manifest.files.length-overlays.length,unchangedArchiveFiles:beforeFiles.length-2,
  observedConfigurationDrift,installedOrRestarted:false};
writeFileSync(marker,JSON.stringify(evidence,null,2));
console.log(JSON.stringify({runtime,archive,bundleId:manifest.bundleId,archiveChanges,overlays:overlays.map(o=>({path:o.path,queueCheck:o.queueCheck}))},null,2));
