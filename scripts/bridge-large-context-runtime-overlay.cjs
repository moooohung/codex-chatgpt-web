const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
// Patch only reviewed R11 nodes. Unknown shapes fail before staging/installing any live artifact.
const root=path.resolve(__dirname,'..'),ns='__codexLargeContext20261007';
const parse=(text,name='runtime.js')=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);
const nodes=(node,predicate)=>{const found=[];function visit(n){if(predicate(n))found.push(n);ts.forEachChild(n,visit)}visit(node);return found};
const one=(items,label)=>{if(items.length!==1)throw Error(label+': expected one, got '+items.length);return items[0]};
const source=(relative)=>parse(fs.readFileSync(path.join(root,relative),'utf8'),relative);
const identifier=(name)=>ts.factory.createIdentifier(name);
function transpile(node,file,bindings={}) {
 const replacement=name=>parse('const value='+bindings[name]).statements[0].declarationList.declarations[0].initializer;
 const transformed=ts.transform(node,[context=>{
  const visit=n=>{
   if(ts.isShorthandPropertyAssignment(n)&&bindings[n.name.text])return ts.factory.createPropertyAssignment(n.name,replacement(n.name.text));
   if(ts.isIdentifier(n)&&bindings[n.text]&&!((ts.isPropertyAccessExpression(n.parent)&&n.parent.name===n)
     ||(ts.isPropertyAssignment(n.parent)&&n.parent.name===n)))return replacement(n.text);
   return ts.visitEachChild(n,visit,context);
  };return n=>ts.visitNode(n,visit);
 }]);
 const text=ts.createPrinter().printNode(ts.EmitHint.Unspecified,transformed.transformed[0],file);transformed.dispose();
 const wrapped=ts.isArrowFunction(node)?'const __owned='+text:text;
 const output=new Bun.Transpiler({loader:'ts'}).transformSync(wrapped);
 if(!ts.isArrowFunction(node))return output.replace(/^export\s+/,'');
 const f=parse(output);return f.statements[0].declarationList.declarations[0].initializer.getText(f);
}
module.exports=function patchRuntime(code,relative){
 const f=parse(code),edits=[];let runtimeBindings;
 const replace=(node,value,label)=>edits.push({start:node.getStart(f),end:node.end,value,label,original:node.getText(f)});
 const insert=(start,value,label)=>{const previous=edits.find(e=>e.start===start&&e.end===start);if(previous){previous.value+=value;previous.label+='; '+label}else edits.push({start,end:start,value,label,original:''})};
 if(nodes(f,n=>ts.isFunctionDeclaration(n)&&[ns,'__codexSubmissionUi20261007'].includes(n.name?.text)).length)throw Error('R12 already present');
 const adapters=nodes(f,n=>ts.isFunctionDeclaration(n)&&n.body?.getText(f).includes('compaction uses configured fresh conversation mode'));
 if(adapters.length!==(relative==='app/cli.js'?1:relative==='app/browser-helper.cjs'?0:-1))throw Error('Unreviewed bundle adapter shape');
 if(adapters.length){
 const adapter=adapters[0];
 const startup=one(nodes(adapter,n=>ts.isVariableDeclaration(n)&&n.initializer&&ts.isArrowFunction(n.initializer)&&n.initializer.parameters.length===5&&n.initializer.getText(f).includes('ChatGPT Zero Risk requires the Zero Risk Web model route')),'runtime startup');
 const startupArrow=startup.initializer,[parsed,environment,trace,capabilities,hooks]=startupArrow.parameters.map(p=>p.name.getText(f));
 if(startupArrow.parameters.length!==5)throw Error('Runtime startup parameters changed');
 const compile=one(nodes(startupArrow,n=>ts.isVariableDeclaration(n)&&n.initializer&&ts.isArrowFunction(n.initializer)&&n.initializer.getText(f).includes('preserveCompactionHistory:')),'compile options');
 const properties=one(nodes(compile.initializer,n=>ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(f)==='captureLunaCheckpoint')),'compile properties');
 const property=name=>one(properties.properties.filter(p=>p.name?.getText(f)===name),'compile '+name).initializer.getText(f);
 const prepCall=one(nodes(compile.initializer,n=>ts.isVariableDeclaration(n)&&n.initializer&&ts.isCallExpression(n.initializer)),'preparation call').initializer;
 const multipart=one(nodes(compile.initializer,n=>ts.isConditionalExpression(n)&&n.whenTrue&&ts.isCallExpression(n.whenTrue)),'multipart options');
 const manual=one(nodes(compile.initializer,n=>ts.isIfStatement(n)),'manual compile guard').expression.getText(f);
 const index=source('src/adapters/chatgpt-web/index.ts');
 const ownedCompile=one(nodes(index,n=>ts.isVariableDeclaration(n)&&n.name.getText(index)==='compileOptionsFor'),'owned compile').initializer;
 const compileBindings={manualRequest:manual,hooks,
  createChatGptWebPromptPreparation:prepCall.expression.getText(f),experimentalBiggerContext:multipart.condition.getText(f),
  resolveBiggerContextMultipartParts:multipart.whenTrue.expression.getText(f),turnCapabilities:capabilities,
  experimentalSkillAttachments:property('experimentalSkillAttachments'),captureLunaCheckpoint:property('captureLunaCheckpoint'),
  minimalTransport:one(nodes(properties,n=>ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken),'minimal transport').right.getText(f)};
 replace(compile.initializer,transpile(ownedCompile,index,compileBindings),'bounded compile options');
 const errorFactory=one(nodes(f,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='__codexToolBoundary20261007'),'R11 boundary factory');
 const errorAlias=one(nodes(errorFactory,n=>ts.isVariableDeclaration(n)&&n.name.getText(f)==='ChatGptWebAdapterError'),'adapter error alias').initializer.getText(f);
 const prepare=one(nodes(startupArrow,n=>ts.isPropertyAssignment(n)&&n.name.getText(f)==='prepare'&&ts.isArrowFunction(n.initializer)
  &&n.initializer.getText(f).includes('release:')&&n.initializer.getText(f).includes(compile.name.getText(f)+'(')),'read-only prepare');
 const compiler=one(nodes(prepare,n=>ts.isCallExpression(n)&&n.arguments.length===4),'prompt compiler');
 const ownedPrepare=one(nodes(index,n=>ts.isPropertyAssignment(n)&&n.name.getText(index)==='prepare'
  &&n.initializer.getText(index).includes('compaction_stage_too_large')),'owned bounded prepare').initializer;
 const prepareBindings={hooks,compileChatGptWebPrompt:compiler.expression.getText(f),
  checkpointInput:compiler.arguments[0].expression.getText(f),turnCapabilities:capabilities,
  compileOptionsFor:compile.name.getText(f),ChatGptWebAdapterError:errorAlias};
 replace(prepare.initializer,transpile(ownedPrepare,index,prepareBindings),'reject oversized compaction before send');
 const fresh=one(nodes(adapter,n=>ts.isVariableDeclaration(n)&&n.initializer&&ts.isArrowFunction(n.initializer)&&n.initializer.parameters.length===1
  &&n.initializer.getText(f).includes('compaction uses configured fresh conversation mode')),'fresh compaction');
 const freshArrow=fresh.initializer;
 const startCall=one(nodes(freshArrow,n=>ts.isCallExpression(n)&&n.expression.getText(f)===startup.name.getText(f)),'fresh startup call');
 const progress=one(nodes(startCall,n=>ts.isPropertyAssignment(n)&&n.name.getText(f)==='onCompactionProgress'),'handoff rearm').initializer.getText(f);
 const phase=one(nodes(freshArrow,n=>ts.isBinaryExpression(n)&&n.right.getText(f)==='"fresh_compaction"'),'handoff phase').left.getText(f);
 const freshCondition=one(nodes(freshArrow,n=>ts.isIfStatement(n)&&n.thenStatement.getText(f).includes('configured fresh conversation mode')),'fresh mode').expression;
 const freshMode=(ts.isBinaryExpression(freshCondition)&&freshCondition.operatorToken.kind===ts.SyntaxKind.CommaToken?freshCondition.right:freshCondition).getText(f);
 const freshManual=startCall.arguments[1].condition.getText(f);
 const runtime=one(nodes(freshArrow,n=>ts.isVariableDeclaration(n)&&n.initializer===startCall),'fresh runtime').name.getText(f);
 const ownership=one(nodes(freshArrow,n=>ts.isCallExpression(n)&&n.arguments.length===1&&n.arguments[0].getText(f)===runtime+'.physicalSettlement'),'physical owner').expression.getText(f);
 const wait=one(nodes(freshArrow,n=>ts.isCallExpression(n)&&n.arguments[0]?.getText(f)===runtime+'.browser'),'browser wait');
 const canonical=one(nodes(freshArrow,n=>ts.isCallExpression(n)&&n.arguments.length===2&&n.arguments[0].getText(f)===parsed),'canonical summary').expression.getText(f);
 const hash=one(nodes(adapter,n=>ts.isCallExpression(n)&&n.arguments[0]?.getText(f)==='"sha256"'&&n.parent.parent.getText(f).includes(':handoff')),'hash dependency').expression.getText(f);
 const compactionLog=one(nodes(adapter,n=>ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(f)==='timeoutMs')
  &&n.properties.some(p=>p.name?.getText(f)==='phase')),'compaction log');
 const compactionTrace=one(compactionLog.properties.filter(p=>p.name?.getText(f)==='traceId'),'compaction trace').initializer.getText(f);
 const ownedFresh=one(nodes(index,n=>ts.isVariableDeclaration(n)&&n.name.getText(index)==='runFreshCompaction'),'owned fresh compaction').initializer;
 const bindings={handoffPhase:phase,freshConversationPerTurn:freshMode,armHandoffDeadline:progress,manualRequest:freshManual,
  startRuntime:startup.name.getText(f),parsed,environment:startCall.arguments[1].whenTrue.getText(f),freshCompactionTraceId:startCall.arguments[2].getText(f),
  turnCapabilities:startCall.arguments[3].getText(f),retainOwnershipUntil:ownership,withAbort:wait.expression.getText(f),
  operationSignal:wait.arguments[1].getText(f),canonicalizeCompactionHandoff:canonical,compactionTraceId:compactionTrace,
  largeCompaction:'__largeCompaction',runLargeContextCompaction:ns+'().runLargeContextCompaction'};
 replace(fresh,`__largeCompaction=${freshManual}?void 0:${ns}().planLargeContextCompaction(${parsed}),${fresh.name.getText(f)}=`+transpile(ownedFresh,index,bindings),'sequential compaction with physical settlement');
 const freshBranch=one(nodes(adapter,n=>ts.isIfStatement(n)&&n.expression.getText(f)===freshMode&&n.thenStatement.getText(f).includes('"configured_fresh_conversation"')),'fresh source retirement');
 replace(freshBranch.expression,freshMode+'||__largeCompaction','large context retires giant source');
 const reason=one(nodes(freshBranch,n=>ts.isStringLiteral(n)&&n.text==='configured_fresh_conversation'),'fresh reason');
 replace(reason,'(__largeCompaction?"large_context_bounded_stages":"configured_fresh_conversation")','diagnose staged source retirement');
 const compactPrompt=one(nodes(f,n=>ts.isVariableDeclaration(n)&&n.initializer&&ts.isTemplateExpression(n.initializer)===false
  &&n.initializer.getText(f).includes('You are performing a CONTEXT CHECKPOINT COMPACTION.')),'Codex compact prompt').name.getText(f);
 const moduleFile=source('src/adapters/chatgpt-web/large-context-compaction.ts');
 const moduleBody=moduleFile.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(moduleFile).replace(/^export\s+/,'' )).join('\n');
 const moduleCode=new Bun.Transpiler({loader:'ts'}).transformSync(moduleBody);
 runtimeBindings={adapter:adapter.name.getText(f),startup:startup.name.getText(f),compileOptions:compile.name.getText(f),
  fresh:fresh.name.getText(f),compileBindings,prepareBindings,freshBindings:bindings,hash,compactPrompt,errorAlias};
 insert(code.length,`\nfunction ${ns}(){const createHash=${hash},COMPACT_PROMPT=${compactPrompt},ChatGptWebAdapterError=${errorAlias};${moduleCode};return{planLargeContextCompaction,runLargeContextCompaction,splitCompactionSource,compactionTransportBytes};}\n`,'standalone bounded compaction planner');
 }
 const submission=one(nodes(f,n=>ts.isMethodDeclaration(n)&&n.name.getText(f)==='submissionDomState'),'submission method');
 const evaluate=one(nodes(submission,n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='evaluate'),'submission projection');
 const ui=source('src/adapters/chatgpt-web/submission-ui.ts');
 const uiFunction=one(nodes(ui,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='chatGptSubmissionDomProjection'),'owned submission UI');
 replace(evaluate.arguments[0],'__codexSubmissionUi20261007','DOM-preserving history rendering projection');
 insert(code.length,'\n'+transpile(uiFunction,ui).replace('chatGptSubmissionDomProjection','__codexSubmissionUi20261007'),'standalone submission UI');
 const observed=one(nodes(submission,n=>ts.isVariableDeclaration(n)&&n.initializer?.getText(f).includes('.evaluate(')),'observed state').name.getText(f);
 const snapshot=one(nodes(submission,n=>ts.isVariableDeclaration(n)&&n.initializer?.getText(f).includes('.snapshot??')),'cached snapshot');
 // A separate statement is required: the existing variable declaration may share declarators.
 replace(snapshot.initializer,`(__codexPageObservationBudget20261007.recordChatGptPageObservationSize(${submission.parameters[0].name.getText(f)},${observed}.bodyTextChars),${snapshot.initializer.getText(f)})`,'measure size on submission/cache reads');
 const capture=one(nodes(f,n=>ts.isMethodDeclaration(n)&&n.name.getText(f)==='capture'&&n.body?.getText(f).includes('CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS')),'diagnostic capture');
 insert(capture.body.statements[0].getStart(f),'const __pageObservationStarted=Date.now();','diagnostic elapsed start');
 const record=one(nodes(capture,n=>ts.isCallExpression(n)&&n.expression.getText(f).endsWith('.recordChatGptPageObservationSize')),'diagnostic body measurement');
 const result=record.arguments[1].expression.expression.getText(f);
 const timeout=one(nodes(capture,n=>ts.isVariableDeclaration(n)&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(f).endsWith('.chatGptPageObservationTimeoutMs')),'diagnostic timeout').name.getText(f);
 let recordStatement=record;while(!ts.isIfStatement(recordStatement))recordStatement=recordStatement.parent;
 insert(recordStatement.end,`;console.info("[chatgpt-web] page_stage "+JSON.stringify({traceId:this.traceId.slice(0,12),checkpoint:${capture.parameters[1].name.getText(f)},bodyTextChars:${result}.status==="fulfilled"?(${result}.value.bodyTextChars??null):null,observationMs:Date.now()-__pageObservationStarted,observationTimeoutMs:${timeout},observationFailed:${result}.status==="rejected"}));`,'token-free per-stage page metrics');
 const sorted=[...edits].sort((a,b)=>b.start-a.start);for(let i=1;i<sorted.length;i++)if(sorted[i].end>sorted[i-1].start)throw Error('Overlapping R12 edits');
 let next=code;for(const e of sorted)next=next.slice(0,e.start)+e.value+next.slice(e.end);
 const restoration=[];let offset=0;for(const e of [...edits].sort((a,b)=>a.start-b.start)){restoration.push({...e,changedStart:e.start+offset});offset+=e.value.length-(e.end-e.start)}
 let restored=next;for(const e of restoration.reverse())restored=restored.slice(0,e.changedStart)+e.original+restored.slice(e.changedStart+e.value.length);
 if(restored!==code||parse(next).parseDiagnostics.length)throw Error('R12 reverse byte proof or parse failed');
 return{code:next,evidence:{relative,reverseRestoresOriginalBytes:true,edits:edits.map(e=>e.label),...(runtimeBindings?{runtimeBindings}:{})}};
};
