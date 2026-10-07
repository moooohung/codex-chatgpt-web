import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("real DOM selection waits for a replaced family portal and delayed menu closure before Send verification", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    page.setDefaultTimeout(5_000);
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Unsent draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Medium</button></form>
      <div id="picker" role="menu" hidden><div data-model-picker-view="advanced">
        <div role="menuitem" data-model-picker-view-toggle="true" aria-hidden="false"><span data-menu-row-content>5.6 Medium</span></div>
        <div role="menuitemradio" aria-checked="true">Latest</div>
        <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div>
        <span id="announcement">Medium, 2 of 5.</span>
        <div role="menuitem" aria-describedby="announcement" tabindex="0"><div data-model-picker-power-slider style="width:200px;height:24px"></div></div>
      </div></div><script>
      const control = document.querySelector('button'); let menu = document.querySelector('#picker'), value = 1, clicks = 0;
      const efforts = ['Instant','Medium','High','Extra High','Pro'];
      function render() {
        menu.querySelector('[data-model-picker-power-slider]').innerHTML = '<span data-orientation="horizontal" aria-disabled="false">'
          + efforts.map((_, i) => '<span data-selected="' + (i <= value) + '"></span>').join('')
          + '<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="' + value + '"></span></span>';
        menu.querySelector('[data-menu-row-content]').textContent = '5.6 ' + efforts[value];
        menu.querySelector('#announcement').textContent = efforts[value] + ', ' + (value + 1) + ' of 5.';
      }
      control.onclick = () => { menu.hidden = false; control.setAttribute('aria-expanded','true'); control.textContent = 'Thinking effort'; render(); };
      menu.querySelectorAll('[role="menuitemradio"]')[1].onclick = () => {
        clicks++; window.familyClicks = clicks;
        const replacement = menu.cloneNode(true); replacement.id = 'picker-replaced'; menu.replaceWith(replacement); menu = replacement;
        control.setAttribute('aria-controls', 'picker-replaced');
        setTimeout(() => { const rows = menu.querySelectorAll('[role="menuitemradio"]'); rows[0].setAttribute('aria-checked','false'); rows[1].setAttribute('aria-checked','true'); }, 1300);
      };
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setTimeout(() => { menu.hidden = true; control.setAttribute('aria-expanded','false'); control.textContent = efforts[value]; }, 300);
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { value += event.key === 'ArrowRight' ? 1 : -1; render(); event.preventDefault(); }
      });
      </script>`);
    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "high", {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    }, undefined, false, "5.6");
    await worker.assertSelectedEffort(page, mode);
    expect(mode.modelFamily).toBe("5.6"); expect(mode.effort).toBe("high");
    expect(mode.selection.label).toBe("High");
    expect(await page.evaluate(() => (window as any).familyClicks)).toBe(1);
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Unsent draft");
  } finally { await browser.close(); }
}, 30_000);
