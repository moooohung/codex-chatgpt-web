const {execFileSync}=require('node:child_process');
const {mkdirSync,writeFileSync}=require('node:fs');
const {join,dirname,resolve}=require('node:path');
const {createHash}=require('node:crypto');
function freezeLegacy(sourceRoot,outputRoot) {
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();
  const files=execFileSync('git',['ls-tree','-r','--name-only',revision,'--','launcher/electron'],{cwd:sourceRoot,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  const entries=[];
  for(const file of files) {
    const data=execFileSync('git',['show',revision+':'+file],{cwd:sourceRoot,maxBuffer:4*1024*1024});
    const target=join(resolve(outputRoot),file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data);
    entries.push({path:file,sha256:createHash('sha256').update(data).digest('hex')});
  }
  const manifest={revision,entries};writeFileSync(join(outputRoot,'legacy-source-manifest.json'),JSON.stringify(manifest,null,2));
  return {legacyRoot:join(resolve(outputRoot),'launcher','electron'),manifest};
}
if(require.main===module)console.log(JSON.stringify(freezeLegacy(resolve(__dirname,'../..'),resolve(process.argv[2]))));
module.exports={freezeLegacy};
