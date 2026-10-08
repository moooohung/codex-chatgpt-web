import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { activateChatGptEffortMenu } from "../src/chatgpt-session";
import { selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

const fixture=readFileSync(new URL("./fixtures/chatgpt-model-picker-oct7.html",import.meta.url),"utf8");
const caps={localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true};

for(const [family,effort] of [["5.6","high"],["5.6","low"]] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`October picker selects ${family}/${effort} with an attribute-free view action and effort-only header`,async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try{
    const page=await browser.newPage();await page.route("**/*",route=>route.abort());await page.setContent(fixture);
    const worker: any=Object.create(ChatGptBrowserWorker.prototype);
    const mode=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,effort,caps,undefined,false,family);
    await worker.assertSelectedEffort(page,mode);
    expect(mode.modelFamily).toBe(family);expect(mode.effort).toBe(effort);
    expect(await page.evaluate(()=>(window as any).familySelections)).toEqual(["5.6"]);
    expect(await page.evaluate(()=>(window as any).sends)).toBe(0);
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Unsent draft");
    if(effort==="low"){
      const final=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,"max",caps,undefined,false,"6");
      await worker.assertSelectedEffort(page,final);
      expect(final.modelFamily).toBe("6");expect(final.effort).toBe("max");expect(final.selection.label).toBe("Pro");
      expect(await page.evaluate(()=>(window as any).familySelections)).toEqual(["5.6","latest"]);
      expect(await page.evaluate(()=>(window as any).sends)).toBe(0);
    }
  }finally{await browser.close();}
},30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an attribute-free action still rejects hidden or inert model-view alternatives",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try{
    const page=await browser.newPage();await page.route("**/*",route=>route.abort());await page.setContent(fixture);
    await page.locator('[data-model-picker-view]').evaluate(el=>{
      for(const attribute of ['inert','aria-hidden="true"','hidden']) el.insertAdjacentHTML('beforeend',`<div ${attribute}><div data-model-picker-view-toggle="true">Wrong model</div></div>`);
    });
    const control=page.locator('button[data-codex-intelligence-trigger]');
    const activation=await activateChatGptEffortMenu(page,control);
    const selected=await selectChatGptModelFamily(activation,"5.6",()=>activateChatGptEffortMenu(page,control));
    expect(await selected.menu.getByRole('menuitemradio',{name:'GPT-5.6 Sol',includeHidden:true,exact:true}).getAttribute('aria-checked')).toBe("true");
    expect(await page.evaluate(()=>(window as any).sends)).toBe(0);
  }finally{await browser.close();}
},30_000);
