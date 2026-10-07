const { readFileSync }=require('node:fs');
const { createRequire }=require('node:module');
const { join }=require('node:path');

// Extract the existing action functions from the reviewed launcher source. The same
// validation and setup transactions run in both hosts; no second menu implementation.
function registerLegacyActions(legacyRoot,scope) {
  const typescript=require('../node_modules/typescript');
  const main=join(legacyRoot,'main.cjs'), source=readFileSync(main,'utf8');
  const ast=typescript.createSourceFile(main,source,typescript.ScriptTarget.Latest,true,typescript.ScriptKind.JS);
  const names=['validateLanguage','validateBrowserInteractionMode','validateBounds','smokePassedForCurrentVersion','syncBrowserPreferences','windowStateSnapshot','nativeCopyFor','stopCatalogVerificationMonitor','startCatalogVerificationMonitor','updateTrayMenu','registerIpc'];
  const functions=names.map(name=>{
    const nodes=ast.statements.filter(node=>typescript.isFunctionDeclaration(node)&&node.name?.text===name);
    if(nodes.length!==1)throw new Error('Review the changed launcher action function: '+name);return nodes[0].getText(ast);
  });
  const copy=ast.statements.flatMap(node=>typescript.isVariableStatement(node)?[...node.declarationList.declarations]:[]).find(node=>node.name.getText(ast)==='NATIVE_COPY');
  if(!copy?.initializer)throw new Error('Native launcher translations are missing');
  const load=createRequire(main);
  Object.assign(scope,{languages:load('./languages.json'),createAccountApi:load('./account-api.cjs').createAccountApi,
    path:require('node:path'),...load('./state.cjs'),...load('./logging.cjs'),...load('./autostart.cjs'),...load('./retained-turn-release.cjs')});
  // Only trusted, locally packaged source enters this scope. Runtime messages are data.
  const exported=new Function('scope',`with(scope){const NATIVE_COPY=${copy.initializer.getText(ast)};${functions.join('\n')}registerIpc({logger,stateStore});return {syncBrowserPreferences,stopCatalogVerificationMonitor,startCatalogVerificationMonitor,updateTrayMenu};}`)(scope);
  Object.assign(scope,exported);
  return {actionCount:scope.ipcMain.handlers.size,sourceFunctions:names};
}
module.exports={registerLegacyActions};
