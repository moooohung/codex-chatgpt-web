import { expect, test } from "bun:test";
import vm from "node:vm";
import ts from "typescript";
import { memoryOverlay } from "../scripts/installed-memory-overlay";

const queue = `class Queue{pending=[];running=0;closed=false;constructor(capacity=8){this.capacity=capacity;if(capacity<1)throw Error("Invalid browser concurrency capacity")}run(){}}`;
const registry = `class Registry{getOrCreate(){if(this.active>=limit)throw Error(\`ChatGPT Web supports at most \${limit} simultaneous browser turns; close or finish a browser tab before starting another\`);return "admitted"}}`;

test("the installed overlay changes only queue defaults and the logical backlog bound", () => {
  const input = `const untouched="sentinel";const limit=8;${queue};${registry};`;
  const patched = memoryOverlay(input, "cli.js", true);
  expect(patched.edits.length).toBe(3);
  expect(patched.code).toContain('const untouched="sentinel"');
  for (const [raw, capacity] of [[undefined,4],["1",1],["8",8],["9",4],["NaN",4]] as const) {
    const result = vm.runInNewContext(`${patched.code};({capacity:new Queue().capacity, registry:new Registry()})`,
      {process:{env:{CODEX_WEB_GPT_MAX_BROWSER_TABS:raw}}});
    expect(result.capacity).toBe(capacity);
    result.registry.active=5;
    expect(result.registry.getOrCreate()).toBe("admitted");
    result.registry.active=32;
    expect(()=>result.registry.getOrCreate()).toThrow("at most 32 active or queued turns");
  }
});

test("the helper overlay does not require or invent a session registry", () => {
  const patched=memoryOverlay(queue,"browser-helper.cjs",false);
  expect(patched.edits.length).toBe(1);
  expect(vm.runInNewContext(`${patched.code};new Queue().capacity`, {process:{env:{}}})).toBe(4);
});

test("unknown, duplicate, already patched, and invalid bundles fail before a write", () => {
  for(const input of ["not valid {", queue.replace("capacity=8","capacity=6"), `${queue};${queue}`, "const unrelated=8;"]) {
    expect(()=>memoryOverlay(input,"helper.cjs",false)).toThrow();
  }
  expect(()=>memoryOverlay(memoryOverlay(queue,"helper.cjs",false).code,"helper.cjs",false)).toThrow();
});
