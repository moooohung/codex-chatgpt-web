const {app,BrowserWindow}=require('electron');
let window;
let exiting=false;
const fail=error=>{
 if(exiting)return;
 exiting=true;
 console.error('CONTEXT_REGEXP_ERROR '+(error?.stack||String(error)));
 // Handling both main-process failure paths prevents Electron's modal error dialog.
 // This process owns only the hidden synthetic window and its fresh profile.
 try{if(window&&!window.isDestroyed())window.destroy();}catch{}
 app.exit(1);
};
process.on('uncaughtException',fail);
process.on('unhandledRejection',fail);
const {source,flags}=require('./chatgpt-link-regexp.json');
const original=JSON.stringify([{type:'input_text',text:'```a``` '.repeat(12)}]);
const fixed=process.env.CHATGPT_LINK_TEST_INPUT;
// Keep fixture data inert when constructing renderer JavaScript, including HTML delimiters.
const jsLiteral=value=>JSON.stringify(value).replace(/[<>\u2028\u2029]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
const watchdog=setTimeout(()=>fail(Error('Synthetic regexp fixture exceeded its 15 second budget')),15000);
(async()=>{
 if(typeof fixed!=='string')throw Error('CHATGPT_LINK_TEST_INPUT is required');
 await app.whenReady();
 console.error('CONTEXT_REGEXP_PHASE ready');
 window=new BrowserWindow({show:false,skipTaskbar:true,webPreferences:{sandbox:true}});
 const run=input=>window.webContents.executeJavaScript(`(()=>{const t=performance.now();new RegExp(${jsLiteral(source)},${jsLiteral(flags)}).exec(${jsLiteral(input)});return {elapsed:performance.now()-t,decoded:JSON.parse(${jsLiteral(input)})};})()`);
 await window.loadURL('data:text/html,<title>isolated-regexp-regression</title>');
 const stalledRendererPid=window.webContents.getOSProcessId();
 if(!Number.isSafeInteger(stalledRendererPid)||stalledRendererPid<=0||stalledRendererPid===process.pid)throw Error('Missing owned synthetic renderer PID');
 const before=await Promise.race([run(original).then(()=> 'returned',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('timeout'),500))]);
 if(before!=='timeout')throw Error('Original regex did not reproduce the renderer stall');
 console.error('CONTEXT_REGEXP_PHASE original-stalled');
 const rendererGone=new Promise(resolve=>window.webContents.once('render-process-gone',resolve));
 // forcefullyCrashRenderer() can wait for a V8 task in the catastrophic regex on
 // Windows. Terminate only the renderer captured from this fixture's hidden window,
 // in its separate Electron process/profile, then wait for Chromium to confirm it.
 process.kill(stalledRendererPid,'SIGKILL');
 await Promise.race([rendererGone,new Promise((_,reject)=>setTimeout(()=>reject(Error('Stalled synthetic renderer did not exit')),3000))]);
 console.error('CONTEXT_REGEXP_PHASE renderer-stopped');
 await window.loadURL('data:text/html,<title>isolated-regexp-regression-fixed</title>');
 const after=await Promise.race([run(fixed),new Promise((_,j)=>setTimeout(()=>j(Error('fixed regex stalled')),2000))]);
 if(JSON.stringify(after.decoded)!==original)throw Error('Context changed after Unicode decoding');
 console.log('CONTEXT_REGEXP_RESULT '+JSON.stringify({before,afterMs:after.elapsed,roundTrip:true}));
 clearTimeout(watchdog);
 exiting=true;
 window.destroy();app.quit();
})().catch(fail);
