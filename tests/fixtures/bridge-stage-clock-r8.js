// Reduced from installed R8 CLI: preserve the actual runStage method and argument spill.
const _o = { start() {}, suspendedMs() { return 0; } };
const rT = (budget, elapsed, suspended) => budget - elapsed + suspended;
class Ft extends Error {}
function __codexSelectionLag20261007() { return { chatGptModelSelectionStageError: (error, stage) => typeof annotate === "function" ? annotate(error, stage) : error }; }
class Worker {
  async runStage(e,t,n,r,o=_o,i=!1){_o.start();let a=performance.now(),s=o.suspendedMs();console.info(`[chatgpt-web] browser turn ${e} stage=${t} started`);let c=new AbortController,l,u=!1,d;try{let p=new Promise((f,h)=>{let b=()=>{let g=o.suspendedMs()-s,C=rT(n,performance.now()-a,g);if(C>0){l=setTimeout(b,C);return}u=!0,c.abort(),h(Error(`ChatGPT browser stage timed out: ${t}`))};l=setTimeout(b,n)});d=r(c.signal);let m=await Promise.race([d,p]);return console.info(`[chatgpt-web] browser turn ${e} stage=${t} completed durationMs=${Math.round(performance.now()-a)}`),m}catch(p){let m=p;if(u&&i&&d)try{await d}catch(f){if(f instanceof Ft)m=f}throw console.error(`[chatgpt-web] browser turn ${e} stage=${t} failed durationMs=${Math.round(performance.now()-a)}: ${m instanceof Error?m.message:String(m)}`),m=__codexSelectionLag20261007().chatGptModelSelectionStageError(console.error(`[chatgpt-web] browser turn ${e} stage=${t} failed durationMs=${Math.round(performance.now()-a)}: ${m instanceof Error?m.message:String(m)}`),m,t);console.error(`[chatgpt-web] browser turn ${e} stage=${t} failed durationMs=${Math.round(performance.now()-a)}: ${m instanceof Error?m.message:String(m)}`),m}finally{if(l)clearTimeout(l)}}
  async valid(e, action) {
    await this.runStage(e.traceId, "browser_page", 1000, action);
    await this.runStage(e.traceId, `multipart_stage_${1}_acknowledgement`, 1000, action, _o);
    await this.runStage(e.traceId, "prompt_attachment", 1000, action, _o, !0);
    await this.runStage(e.traceId, e.multipart ? "multipart_commit_send" : "send", 1000, action);
  }
  async broken(e, l, w, C, Ve, _e) {
    return this.runStage(e.traceId,await l.capture(w,"browser-page-acquired"),console.info("browser opened"),C?"multipart_staging_effort_selection":"effort_selection",Ve.effortSelection,_e);
  }
}
({ Worker, clock: _o });
