const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
// This reviewed R10 overlay fails on an unfamiliar bundle rather than rewriting unrelated code.
// Bun transpiles only the owned source functions; every other runtime byte must reverse unchanged.
const root=path.resolve(__dirname,'..');
const parse=(code,name='runtime.js')=>ts.createSourceFile(name,code,ts.ScriptTarget.Latest,true);
const nodes=(node,predicate)=>{const found=[];const visit=n=>{if(predicate(n))found.push(n);ts.forEachChild(n,visit)};visit(node);return found};
const one=(values,label)=>{if(values.length!==1)throw Error(label+': expected one, got '+values.length);return values[0]};
const transpile=code=>new Bun.Transpiler({loader:'ts'}).transformSync(code);
const ns='__codexToolBoundary20261007';
module.exports=function patchRuntime(code,relative){
 const f=parse(code),edits=[];
 const method=name=>one(nodes(f,n=>ts.isMethodDeclaration(n)&&n.name.getText(f)===name),name);
 const fn=name=>one(nodes(f,n=>ts.isFunctionDeclaration(n)&&n.name?.text===name),name);
 const replace=(n,value,label)=>edits.push({start:n.getStart(f),end:n.end,value,label,original:n.getText(f)});
 const factory=fn(ns);
 const adapter=one(nodes(factory,n=>ts.isVariableDeclaration(n)&&n.name.getText(f)==='ChatGptWebAdapterError'),'adapter alias').initializer.getText(f);
 const loggerSource=fs.readFileSync(path.join(root,'src/adapters/chatgpt-web/tool-boundary.ts'),'utf8');
 const loggerFile=parse(loggerSource,'tool-boundary.ts');
 const logger=one(nodes(loggerFile,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='logChatGptBrowserObservation'),'owned logger');
 const loggerCode=transpile(logger.getText(loggerFile)).replace(/^export\s+/,'');
 const exports=one(nodes(factory,n=>ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(f)==='track')),'boundary exports');
 const exportReturn=exports.parent;
 if(!ts.isReturnStatement(exportReturn))throw Error('Boundary export return changed');
 edits.push({start:exportReturn.getStart(f),end:exportReturn.getStart(f),value:loggerCode+'\n',label:'bounded token-free observation logger',original:''});
 replace(exports,'{'+exports.properties.map(p=>p.getText(f)).join(',')+',logChatGptBrowserObservation}','logger export');

 const terminal=one(nodes(f,n=>ts.isVariableDeclaration(n)&&n.initializer&&ts.isArrowFunction(n.initializer)&&n.initializer.getText(f).includes('/Something went wrong[\\s\\S]{0,512}help\\.openai\\.com/i')),'old terminal UI scan');
 replace(terminal.initializer,'scope=>({isVisible:()=>scope.locator(":scope").evaluateAll(__codexTerminalUi20261007)})','pruned terminal UI projection');
 const terminalThrow=one(nodes(f,n=>ts.isFunctionDeclaration(n)&&n.body?.getText(f).includes("ChatGPT ended the turn with 'Something went wrong'")),'terminal throw');
 const swallowed=one(nodes(terminalThrow,n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='catch'
  &&n.expression.expression.getText(f).includes(terminal.name.getText(f)+'(')),'terminal observation failure handler');
 replace(swallowed,swallowed.expression.expression.getText(f),'preserve terminal observation failures');
 const projection=transpile(fs.readFileSync(path.join(root,'src/adapters/chatgpt-web/terminal-ui.ts'),'utf8')).replace(/^export\s+/,'').replace('chatGptTerminalErrorUiVisible','__codexTerminalUi20261007');
 edits.push({start:code.length,end:code.length,value:'\n'+projection,label:'standalone terminal UI projection',original:''});

 const observer=method('observeResponseProbe');
 const timeout=one(nodes(observer,n=>ts.isCallExpression(n)&&n.arguments.length===2&&n.arguments[1].getText(f)==='timeoutMs'),'observation timeout alias');
 const abort=timeout.arguments[0];if(!ts.isCallExpression(abort))throw Error('Observation cancellation alias changed');
 const during=one(nodes(observer,n=>ts.isCallExpression(n)&&n.expression.getText(f).endsWith('.observeChatGptToolBoundaryDuring')),'progress observer alias');
 const assistant=method('waitForNewAssistantTurn');
 const timeoutClass=one(nodes(assistant,n=>ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.InstanceOfKeyword),'observation timeout class').right.getText(f);
 const workerSource=fs.readFileSync(path.join(root,'src/adapters/chatgpt-web/browser-worker.ts'),'utf8'),workerFile=parse(workerSource,'browser-worker.ts');
 const owned=one(nodes(workerFile,n=>ts.isMethodDeclaration(n)&&n.name.getText(workerFile)==='observeResponseProbe'),'owned observation method');
 let observerCode=transpile('class Worker {'+owned.getText(workerFile)+'}');
 const observedClass=parse(observerCode),parsedMethod=one(nodes(observedClass,n=>ts.isMethodDeclaration(n)),'transpiled observation method');observerCode=parsedMethod.getText(observedClass);
 const bindings={chatGptPageObservationTimeoutMs:ns.replace('ToolBoundary','PageObservationBudget')+'.chatGptPageObservationTimeoutMs',
  observeChatGptToolBoundaryDuring:during.expression.getText(f),withChatGptBrowserObservationTimeout:timeout.expression.getText(f),withBrowserTurnAbort:abort.expression.getText(f),
  logChatGptBrowserObservation:ns+'().logChatGptBrowserObservation',ChatGptWebAdapterError:adapter,ChatGptBrowserObservationTimeoutError:timeoutClass};
 for(const[from,to]of Object.entries(bindings))observerCode=observerCode.replace(new RegExp('\\b'+from+'\\b','g'),()=>to);
 replace(observer,observerCode,'named bounded observation wrapper');

 const boundary=method('observeSubmissionToolBoundary');
 const currentCall=one(nodes(boundary,n=>ts.isCallExpression(n)&&n.expression.getText(f)==='this.currentSubmissionAnswerText'),'default capture');
 if(currentCall.arguments.length!==3)throw Error('Default boundary argument shape changed');
 replace(currentCall,currentCall.getText(f).slice(0,-1)+',completionTracker)','carry trace tracker into boundary read');
 const current=method('currentSubmissionAnswerText'),[page,baseline,signal]=current.parameters.map(p=>p.name.getText(f));
 if(current.parameters.length!==3)throw Error('Current answer argument shape changed');
 const end=current.parameters[2].end;
 edits.push({start:end,end,value:',completionTracker',label:'boundary tracker parameter',original:''});
 const state=one(nodes(current,n=>ts.isCallExpression(n)&&n.expression.getText(f)==='this.submissionDomState'),'boundary state read');
 replace(state,`this.observeResponseProbe(${page},${baseline},${signal},void 0,completionTracker,ownedSignal=>this.submissionDomState(${page},${baseline}.domCache,ownedSignal),void 0,"boundary_turn_state")`,'time boundary turn identity read');
 const snapshot=one(nodes(current,n=>ts.isCallExpression(n)&&n.expression.getText(f)==='this.responseDomSnapshot'),'boundary projection');
 replace(snapshot,`this.observeResponseProbe(${page},${baseline},${signal},void 0,completionTracker,ownedSignal=>this.boundedResponseDomSnapshot(${page},${snapshot.arguments[0].getText(f)},{},ownedSignal),void 0,"boundary_response_projection")`,'time boundary response projection');
 for(const owner of [current,assistant]){
  const field=one(nodes(owner,n=>ts.isPropertyAccessExpression(n)&&n.name.text==='stoppedThinkingVisible'),'boundary stopped guard').expression.getText(f);
  const returned=one(nodes(owner,n=>ts.isReturnStatement(n)&&n.expression?.getText(f)===field+'.visibleText'),'boundary text return');
  const point=returned.getStart(f);
  edits.push({start:point,end:point,value:`if(${field}.responsePresent===false)throw ${ns}().chatGptToolBoundaryError("chatgpt_tool_boundary_observation_failed");`,label:'reject missing boundary response projection',original:''});
 }

 const session=one(nodes(f,n=>ts.isFunctionDeclaration(n)&&n.body?.getText(f).includes('"chatgpt_session_expired"')&&n.body?.getText(f).includes('"chatgpt_subscription_unavailable"')),'session probe').name.getText(f);
 const rate=one(nodes(f,n=>ts.isFunctionDeclaration(n)&&n.body?.getText(f).includes('ChatGPT rate limit: too many requests. Try again in a few minutes.')),'rate limit probe').name.getText(f);
 const labels=[];
 for(const c of nodes(f,n=>ts.isCallExpression(n)&&n.expression.getText(f)==='this.observeResponseProbe')){
  if(c.arguments.length<6||c.arguments.length>7)throw Error('Existing response probe argument shape changed');
  const body=c.arguments[5].getText(f);
  const label=body.includes(terminalThrow.name.getText(f)+'(')?'terminal_error':body.includes(session+'(')?'session_alert':body.includes(rate+'(')?'rate_limit_dialog'
   :body.includes('this.boundedResponseDomSnapshot(')?'response_projection':body.includes('this.submissionDomState(')?'turn_state'
   :body.includes('chatGptMessageDeliveryTimeoutVisible')?'delivery_timeout':body.includes('"send-accepted"')?'diagnostic_capture':undefined;
  if(!label)continue;
  replace(c,c.getText(f).slice(0,-1)+(c.arguments.length===6?',void 0':'')+','+JSON.stringify(label)+')','label '+label);labels.push(label);
 }
 if(labels.filter(l=>l==='terminal_error').length!==2||labels.filter(l=>l==='response_projection').length!==4)throw Error('Expected multipart and ordinary probe coverage');
 const sorted=[...edits].sort((a,b)=>b.start-a.start);
 for(let i=1;i<sorted.length;i++)if(sorted[i].end>sorted[i-1].start)throw Error('Overlapping runtime edits');
 let next=code;for(const e of sorted)next=next.slice(0,e.start)+e.value+next.slice(e.end);
 const restoration=[];let offset=0;
 for(const e of [...edits].sort((a,b)=>a.start-b.start)){restoration.push({...e,changedStart:e.start+offset});offset+=e.value.length-(e.end-e.start);}
 let restored=next;for(const e of restoration.reverse())restored=restored.slice(0,e.changedStart)+e.original+restored.slice(e.changedStart+e.value.length);
 if(restored!==code||parse(next).parseDiagnostics.length)throw Error('Reverse byte proof or parse failed');
 return{code:next,evidence:{relative,reverseRestoresOriginalBytes:true,edits:edits.map(e=>e.label),labels}};
};
