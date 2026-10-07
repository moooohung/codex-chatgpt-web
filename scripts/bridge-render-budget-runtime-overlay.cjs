const fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
const { assertRunStageCalls } = require("./bridge-run-stage-call-contract.cjs");
const marker = "__codexRenderBudget20261007";
const parse = code => ts.createSourceFile("runtime.js", code, ts.ScriptTarget.Latest, true);
function nodes(root, predicate) { const found=[]; const visit=node=>{if(predicate(node))found.push(node);ts.forEachChild(node,visit);};visit(root);return found; }
function one(items,label){if(items.length!==1)throw Error(label+": expected one, got "+items.length);return items[0];}
function apply(code,edits){
 const ordered=[...edits].sort((a,b)=>a.start-b.start);let next=code,offset=0;
 for(let i=0;i<ordered.length;i++){const e=ordered[i];if(i&&e.start<ordered[i-1].end)throw Error("Overlapping render-budget edits");e.original=code.slice(e.start,e.end);e.changedStart=e.start+offset;offset+=e.value.length-(e.end-e.start);}
 for(const e of [...ordered].reverse())next=next.slice(0,e.start)+e.value+next.slice(e.end);
 let restored=next;for(const e of [...ordered].reverse())restored=restored.slice(0,e.changedStart)+e.original+restored.slice(e.changedStart+e.value.length);
 if(restored!==code||parse(next).parseDiagnostics.length)throw Error("Render-budget reverse-byte proof/parse failed");
 return {code:next,evidence:{reverseRestoresOriginalBytes:true,edits:edits.map(e=>e.label)}};
}
function patchRenderBudgetRuntime(code){
 if(code.includes(marker))throw Error("Render-budget overlay already present");
 if(!code.includes("__codexFailedTab20261007"))throw Error("Expected reviewed failed-tab overlay");
 const file=parse(code),edits=[],replace=(node,value,label)=>edits.push({start:node.getStart(file),end:node.end,value,label}),insert=(start,value,label)=>edits.push({start,end:start,value,label});
 const ui=one(nodes(file,n=>ts.isFunctionDeclaration(n)&&n.name?.text==="__codexSubmissionUi20261007"),"R12 DOM projection");
 const ownedFile=parse(fs.readFileSync(path.join(__dirname,"../src/adapters/chatgpt-web/submission-ui.ts"),"utf8"));
 const owned=one(nodes(ownedFile,n=>ts.isFunctionDeclaration(n)&&n.name?.text==="chatGptSubmissionDomProjection"),"owned DOM projection");
 const compiled=new Bun.Transpiler({loader:"ts"}).transformSync(owned.getText(ownedFile)).replace(/^export\s+/,"").replace("chatGptSubmissionDomProjection","__codexSubmissionUi20261007");
 replace(ui,compiled,"history/input containment and scoped reduced motion/sidebar");
 const browser=one(nodes(file,n=>ts.isMethodDeclaration(n)&&n.name.getText(file)==="runBrowserTurn"),"browser lifecycle");
 const exclusive=one(browser.parent.members.filter(n=>ts.isMethodDeclaration(n)&&n.name.getText(file)==="runExclusive"),"exclusive lifecycle");
 const run=one(nodes(exclusive,n=>ts.isCallExpression(n)&&n.expression.getText(file)==="this.runBrowserTurn"&&n.arguments.length===6),"browser action");
 if(run.arguments.length!==6)throw Error("Unreviewed failed-tab call contract");
 const release=one(nodes(exclusive,n=>ts.isVariableDeclaration(n)&&n.name.getText(file)==="__codexReleaseFailedTab"),"failed release");
 const end=one(nodes(release,n=>ts.isCallExpression(n)&&n.arguments.some(a=>ts.isObjectLiteralExpression(a)&&a.properties.some(p=>p.name?.getText(file)==="phase"&&p.initializer?.getText(file)==='"end"'))),"owned end control");
 const heartbeatStop=one(nodes(release,n=>ts.isCallExpression(n)&&n.expression.getText(file)==="clearInterval"),"stop heartbeat");
 const finished=one(nodes(release,n=>ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&n.right.getText(file)==="true"),"finish activity");
 const turn=exclusive.parameters[0].name.getText(file),descriptor=end.arguments[0].getText(file),notify=end.expression.getText(file),timer=heartbeatStop.arguments[0].getText(file);
 let releaseStatement=release;while(!ts.isVariableStatement(releaseStatement))releaseStatement=releaseStatement.parent;
 insert(releaseStatement.end,`;const ${marker}=async()=>{if(${turn}.retainConversation)return;if(!__codexFailedTab20261007){${finished.left.getText(file)}=true;if(${timer})clearInterval(${timer});__codexFailedTab20261007=${notify}(${descriptor},{phase:"end",traceId:${turn}.traceId,helperPid:process.pid,status:"completed",...(${turn}.nativeConnector||${turn}.capabilities.localToolsEnabled?{connectorBound:true}:{})});}await __codexFailedTab20261007.catch(()=>{});};`,"release completed non-retained lease before final diagnostics");
 insert(run.arguments.end,","+marker,"append optional completion callback without moving arguments");
 if(browser.parameters.length!==6)throw Error("Unreviewed browser signature");
 insert(browser.parameters.end,",__codexOnTurnCompleted","optional private completion callback");
 const capture=one(nodes(browser,n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==="capture"&&n.arguments[1]?.getText(file)==='"turn-completed"'),"completed capture");
 const page=capture.arguments[0].getText(file),awaited=capture.parent;
 if(!ts.isAwaitExpression(awaited))throw Error("Completed diagnostic is not awaited");
 replace(awaited,`(await __codexOnTurnCompleted?.(),${page}.isClosed()?void 0:${awaited.getText(file)})`,"closed completed tab needs no renderer diagnostic");
 const result=apply(code,edits),before=assertRunStageCalls(code),after=assertRunStageCalls(result.code);
 if(JSON.stringify(before.calls.map(c=>c.arguments))!==JSON.stringify(after.calls.map(c=>c.arguments)))throw Error("Render overlay moved runStage arguments");
 return {...result,evidence:{...result.evidence,runStageCallsPreserved:after.calls.length}};
}
function patchResourceBudgetHost(code){
 if(code.includes('require("./browser-resource-budget.cjs")'))throw Error("Resource-budget host already present");
 if(!code.includes("function rendererPidFor("))throw Error("Expected reviewed renderer ownership host");
 const file=parse(code),owned=parse(fs.readFileSync(path.join(__dirname,"../launcher/electron/browser-host.cjs"),"utf8")),edits=[];
 const requireLine=one(owned.statements.filter(n=>n.getText(owned).includes('require("./browser-resource-budget.cjs")')),"resource budget dependency");
 edits.push({start:0,end:0,value:requireLine.getText(owned)+"\n",label:"load scoped native request budget"});
 for(const name of ["configureLocalePreferences","endTurn","removeTurnTab"]){
  const before=one(nodes(file,n=>ts.isMethodDeclaration(n)&&n.name.getText(file)===name),"base "+name);
  const after=one(nodes(owned,n=>ts.isMethodDeclaration(n)&&n.name.getText(owned)===name),"owned "+name);
  edits.push({start:before.getStart(file),end:before.end,value:after.getText(owned),label:name+" scopes optional requests and logs counters before release"});
 }
 return apply(code,edits);
}
module.exports={patchRenderBudgetRuntime,patchResourceBudgetHost};
