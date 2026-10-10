import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { EFFORT_RECHECK_MS } from "../src/adapters/chatgpt-web/effort-ceiling";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("real picker clamps, restores, rechecks at ten minutes, and preserves Pro/family", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">5.6 Sol Medium</button></form>
      <div id="picker" role="menu" hidden><div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div>
      <span id="status">5.6 Medium, 2 of 2.</span><div role="menuitem" tabindex="0" aria-describedby="status">
      <div data-model-picker-power-slider style="height:30px;width:250px"></div></div></div><script>
      window.available=[true,true]; window.value=1; window.opens=0;
      const control=document.querySelector('button'),menu=document.querySelector('#picker'),labels=['Instant','Medium','High','Extra High','Pro'];
      function render(){
        window.value=Math.min(window.value,window.available.length-1);
        document.querySelector('#status').textContent='5.6 '+labels[window.value]+', '+(window.value+1)+' of '+window.available.length+'.';
        document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'
          +window.available.map((v,i)=>'<span data-selected="'+(i<=window.value)+'" data-locked="'+!v+'"></span>').join('')
          +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="'+(window.available.length-1)+'" aria-valuenow="'+window.value+'"></span></span>';
      }
      control.onclick=()=>{window.opens++;menu.hidden=false;control.setAttribute('aria-expanded','true');render()};
      document.addEventListener('keydown',e=>{
        if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent='5.6 Sol '+labels[window.value]}
        if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
          const direction=e.key==='ArrowLeft'?-1:1;window.value+=direction;
          while(window.skipLocked&&!window.available[window.value]&&window.value>0&&window.value<window.available.length-1)window.value+=direction;
          render();e.preventDefault();
        }
      });render();</script>`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const caps = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    const select = (effort = "high") => worker.selectModelAndEffortWithRecovery(page, "gpt-5.6-sol", effort, caps, undefined, false, "5.6");
    const short = await select();
    expect(short).toMatchObject({ effort: "medium", uiEffortIndex: 1, modelFamily: "5.6", requestedMode: { effort: "high" } });
    await worker.assertSelectedEffort(page, short);
    await page.evaluate(() => { (window as any).available = [true, true, true]; });
    const restored = await select();
    expect(restored.effort).toBe("high");
    const opens = await page.evaluate(() => (window as any).opens);
    await select();
    expect(await page.evaluate(() => (window as any).opens)).toBe(opens);
    worker.verifiedEffortSelections.get(page).checkedAt -= EFFORT_RECHECK_MS;
    await select();
    expect(await page.evaluate(() => (window as any).opens)).toBe(opens + 2);
    // A new lock at the last pre-send read clamps and replaces the caller's proof.
    await page.evaluate(() => { (window as any).available = [true, true, false, true]; });
    await worker.assertSelectedEffort(page, restored);
    expect(restored.effort).toBe("medium");
    expect(restored.modelFamily).toBe("5.6");
    expect(await page.locator('[role=slider]').getAttribute('aria-valuenow')).toBe('1');
    await page.evaluate(() => { (window as any).available = [true, false, false, true];
      (window as any).skipLocked = true; (window as any).value = 3; });
    await page.keyboard.press("Escape");
    const skipped = await select();
    expect(skipped.effort).toBe("low");
    expect(await page.locator('[role=slider]').getAttribute('aria-valuenow')).toBe('0');
    for (const available of [[true, true], [true, true, true, true, false]]) {
      await page.evaluate(v => { (window as any).available = v; }, available);
      let error: any;
      try { await select("max"); } catch (v) { error = v; }
      expect(error).toMatchObject({ retryable: false });
      expect(["chatgpt_effort_unavailable", "chatgpt_effort_locked"]).toContain(error.code);
      await page.keyboard.press("Escape");
    }
    expect(await page.locator('[contenteditable]').innerText()).toBe("Draft");
  } finally { await browser.close(); }
}, 60_000);
