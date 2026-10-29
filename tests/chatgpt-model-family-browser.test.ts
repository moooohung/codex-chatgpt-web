// Reproduction contributed by @alexalok in PR #730; explicit picker by @nofihq in #921.
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { readChatGptUsageModel } from "../src/adapters/chatgpt-web/limits";
import { assertChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

// October 28 picker: Default mixes model families; explicit Sol has five
// positions and explicit Astra has six. Never infer a family from Default.
const EXPLICIT_PICKER = readFileSync(new URL("./fixtures/chatgpt-model-picker-explicit-2026-10-28.html", import.meta.url), "utf8");

for (const [effort, label, usageModel] of [["high", "6 Sol High", "other"], ["xhigh", "6 Sol Extra High", "other"], ["max", "6 Astra Max", "gpt-6-pro"]] as const) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`explicit picker selects exact GPT-6 ${effort} beside GPT-6.1`, async () => {
    const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
    try {
      const page=await browser.newPage();await page.setContent(EXPLICIT_PICKER);
      const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
      const mode=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,effort,{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,true,"6");
      expect(mode.selection.label).toBe(label);expect(mode.usageModel).toBe(usageModel);
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Draft');
    } finally {await browser.close();}
  },30_000);
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("explicit picker refuses absent GPT-6 Sol and conflicting GPT-6.1 evidence",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try {
    for(const scenario of ['omitSol','conflictingHeader']){
      const page=await browser.newPage();await page.setContent('<script>window.'+scenario+'=true;</script>'+EXPLICIT_PICKER);
      const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
      let failure: unknown;
      try {
        await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,'high',{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,false,'6');
      } catch (error) { failure=error; }
      expect(String(failure)).toContain('could not be selected and verified');
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Draft');await page.close();
    }
  }finally{await browser.close();}
},30_000);

// Mirrors ChatGPT's power picker as captured live on 2026-09-29 (English, Pro account): the slider
// announcement reads only "Pro, 5 of 5." and the model version appears in the "Select model"
// header as <span>6</span><span data-maximum>Pro</span>. Older pickers announced "6 Pro, 5 of 5.".
type Picker = {
  /** Header version per slider value; null removes the header like older pickers. */
  header: ((value: number) => string) | null;
  /** Slider announcement per effort label and slider value. */
  status: (effort: string, value: number) => string;
};

const PICKERS = {
  splitHeader: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionedAnnouncement: { header: null, status: (effort: string, value: number) => (value === 4 ? "6 " : "5.6 ") + effort + ", " + (value + 1) + " of 5." },
  future: { header: (value: number) => value === 4 ? "7" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionless: { header: () => "", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  conflicting: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => (value === 4 ? "5.6 " : "") + effort + ", " + (value + 1) + " of 5." },
} satisfies Record<string, Picker>;

const FIXTURE = readFileSync(new URL("./fixtures/chatgpt-model-picker-power-2026-09-29.html", import.meta.url), "utf8");

async function selectGpt6Pro(picker: Picker) {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const config = "<script>window.pickerHeader = " + (picker.header ? picker.header.toString() : "null")
      + "; window.pickerStatus = (_effort, value) => "
      + JSON.stringify(["Instant", "Medium", "High", "Extra High", "Pro"].map((effort, value) => picker.status(effort, value)))
      + "[value];</script>";
    await page.setContent(config + FIXTURE);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    try {
      const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      }, undefined, true, "6");
      return { ok: true, label: mode.selection.label, usageModel: mode.usageModel, draft: await page.locator("#prompt-textarea").innerText() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), draft: await page.locator("#prompt-textarea").innerText() };
    }
  } finally {
    await browser.close();
  }
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is verified from the September 29 split picker header when the slider announces only the effort", async () => {
  expect(await selectGpt6Pro(PICKERS.splitHeader)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is still verified from the versioned slider announcement", async () => {
  expect(await selectGpt6Pro(PICKERS.versionedAnnouncement)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

for (const scenario of ["future", "versionless", "conflicting"] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro fails closed when the picker's model evidence is " + scenario, async () => {
  const result = await selectGpt6Pro(PICKERS[scenario]);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("ChatGPT model 6 could not be selected and verified");
  expect(result.draft).toBe("Draft");
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("model evidence excludes inactive and foreign picker headers and rejects multiple active headers", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div role="menu" id="owned">
      <div data-model-picker-view-toggle="true" id="active"><div data-menu-row-content>
        <span>6</span><span>Pro</span><span hidden>5.6</span>
      </div></div>
      <div role="menuitem" aria-describedby="status"><span role="slider"></span></div>
      <span id="status">Pro, 5 of 5.</span>
      <div hidden><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div inert><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div aria-hidden="true"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div style="display:none"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div role="menu"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
    </div><div role="menu"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>`);
    const slider = page.getByRole("slider");
    expect(await readChatGptUsageModel(slider, true)).toBe("gpt-6-pro");
    await page.locator("#active").evaluate(element => element.setAttribute("hidden", ""));
    expect(await readChatGptUsageModel(slider, true)).toBe("pro-unknown");
    await page.locator("#active").evaluate(element => {
      element.removeAttribute("hidden");
      element.after(element.cloneNode(true));
    });
    await expect(readChatGptUsageModel(slider, true)).rejects.toThrow("multiple active model headers");
  } finally {
    await browser.close();
  }
}, 60_000);

// Live 2026-10-02: this 3-step account shows only Instant/Medium/High in its
// header and announcement, with GPT-5.6 Sol checked in the collapsed family view.
for (const [effort, index, label] of [["low", 0, "Instant"], ["medium", 1, "Medium"], ["high", 2, "High"]] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`explicit GPT-5.6 verifies an effort-only picker at ${effort}`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const fixture = FIXTURE
      .replace('aria-checked="true" data-model-selected="true"', 'aria-checked="false"')
      .replace('aria-checked="false" tabindex="-1"><div data-menu-row-content="true"><span>GPT-5.6 Sol', 'aria-checked="true" tabindex="-1"><div data-menu-row-content="true"><span>GPT-5.6 Sol')
      .replace('id="header-effort"', 'id="header-effort" data-effort-only="true"')
      .replace('const efforts = ["Instant", "Medium", "High", "Extra High", "Pro"];', 'const efforts = ["Instant", "Medium", "High"];')
      .replace('aria-valuemax="4"', 'aria-valuemax="2"').replace('Math.min(4, value', 'Math.min(2, value')
      .replace('id="picker" role="menu"', 'id="picker" role="menu" style="opacity:0"');
    await page.setContent('<script>window.pickerHeader = () => ""; window.pickerStatus = (effort, value) => effort + ", " + (value + 1) + " of 3.";</script><div style="opacity:0">' + fixture + '</div>');
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, effort, {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
    }, undefined, true, "5.6");
    expect(mode.selection.label).toBe(label);
    expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe(String(index));
    expect(await page.locator("#prompt-textarea").innerText()).toBe("Draft");
  } finally { await browser.close(); }
}, 60_000);

for (const scenario of ["latest", "ambiguous", "unmarked", "conflicting", "hidden-picker"] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`effort-only model evidence fails closed when ${scenario}`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const selected = scenario === "latest" ? "Latest" : "GPT-5.6 Sol";
    await page.setContent(`<div role="menu" id="owned" ${scenario === "hidden-picker" ? 'style="display:none"' : ""}>
      <div data-model-picker-view-toggle="true"><span ${scenario === "unmarked" ? "" : 'data-effort-only="true"'}>Instant</span></div>
      <div role="menuitem" aria-describedby="announcement"><span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0"></span></div>
      <span id="announcement">${scenario === "conflicting" ? "6 Instant" : "Instant"}, 1 of 3.</span>
      <div hidden><div role="menuitemradio" aria-checked="true">${selected}</div>${scenario === "ambiguous" ? '<div role="menuitemradio" aria-checked="true">GPT-5.5</div>' : ""}</div>
    </div><div role="menu"><div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div></div>`);
    const menu = { menu: page.locator("#owned"), slider: page.locator('#owned [role="slider"]') } as Parameters<typeof assertChatGptModelFamily>[0];
    await expect(assertChatGptModelFamily(menu, "5.6", "low", 0)).rejects.toThrow();
    await expect(assertChatGptModelFamily(menu, "6", "low", 0)).rejects.toThrow();
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("the observed Plus effort-only GPT-6 header uses its explicit checked family, never Latest", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div role="menu" id="owned">
      <div data-model-picker-view-toggle="true"><span data-effort-only="true">Medium</span></div>
      <div role="menuitem" aria-describedby="announcement"><span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1"></span></div>
      <span id="announcement">Medium, 2 of 3.</span>
      <div hidden><div role="menuitemradio" aria-checked="true">GPT-6</div></div>
    </div>`);
    const menu = { menu: page.locator("#owned"), slider: page.locator('[role="slider"]') } as Parameters<typeof assertChatGptModelFamily>[0];
    await assertChatGptModelFamily(menu, "6", "medium", 1);
    await expect(assertChatGptModelFamily(menu, "5.6", "medium", 1)).rejects.toThrow();
    await page.locator('[role="menuitemradio"]').evaluate(el => { el.textContent = "Latest"; });
    await expect(assertChatGptModelFamily(menu, "6", "medium", 1)).rejects.toThrow();
  } finally { await browser.close(); }
}, 20_000);
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("localized position punctuation works through actual picker selection and usage readback", async () => {
  for (const separator of ["、", "،", "；", "—"]) {
    const picker: Picker = { header: null, status: (effort, value) => `${value === 4 ? "6" : "5.6"} ${effort}${separator}5 件中 ${value + 1} 番目。` };
    expect(await selectGpt6Pro(picker)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
  }
}, 60_000);
