import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
const { inspectRunStageCalls, assertRunStageCalls, repairModelSelectionStageCall, repairModelSelectionStageCatch } = require("../scripts/bridge-run-stage-call-contract.cjs");
const fixture = readFileSync(new URL("./fixtures/bridge-stage-clock-r8.js", import.meta.url), "utf8");
const context = () => ({ performance, AbortController, setTimeout, clearTimeout, console: { info() {}, error() {} } });

test("the installed R8 spill fails before any stage action and the complete call audit rejects it", async () => {
  const audit = inspectRunStageCalls(fixture);
  expect(audit.calls).toHaveLength(5);
  expect(audit.calls.filter((call: any) => call.failures.length)).toHaveLength(1);
  expect(() => assertRunStageCalls(fixture)).toThrow("clock-position");
  const { Worker } = vm.runInNewContext(fixture, context());
  let actions = 0;
  await expect(new Worker().broken({ traceId: "regression" }, { capture: async () => {} }, {}, true,
    { effortSelection: 1000 }, async () => { actions++; })).rejects.toThrow("suspendedMs is not a function");
  expect(actions).toBe(0);
});

test.each([false, true])("the surgical repair preserves clock and action slots for multipart=%s", async multipart => {
  const repaired = repairModelSelectionStageCall(fixture);
  expect(repaired.evidence).toMatchObject({ beforeArgc: 6, afterArgc: 4, callsChecked: 5, reverseRestoresOriginalBytes: true });
  expect(assertRunStageCalls(repaired.code).calls.every((call: any) => call.failures.length === 0)).toBe(true);
  const { Worker } = vm.runInNewContext(repaired.code, context());
  let actions = 0, extraCaptures = 0;
  expect(await new Worker().broken({ traceId: "regression" }, { capture: async () => { extraCaptures++; } }, {}, multipart,
    { effortSelection: 1000 }, async () => { actions++; return "selected"; })).toBe("selected");
  expect(actions).toBe(1); expect(extraCaptures).toBe(0);
  await new Worker().valid({ traceId: "regression", multipart }, async () => { actions++; });
  expect(actions).toBe(5);
});

test.each(["true", "42", "{}", "{ suspendedMs: false }"])("all call audit rejects a non-clock fifth argument: %s", badClock => {
  const repaired = repairModelSelectionStageCall(fixture).code;
  const bad = repaired.replace('1000, action, _o);', `1000, action, ${badClock});`);
  expect(() => assertRunStageCalls(bad)).toThrow("clock-position");
});

test("all call audit rejects a displaced action and a non-boolean settlement flag", () => {
  const repaired = repairModelSelectionStageCall(fixture).code;
  expect(() => assertRunStageCalls(repaired.replace('1000, action);', '1000, true);'))).toThrow("action-position");
  expect(() => assertRunStageCalls(repaired.replace('action, _o, !0)', 'action, _o, {})'))).toThrow("settlement-position");
});

test("stage error annotation receives the original error and phase and logs once before throwing", async () => {
  const repaired = repairModelSelectionStageCatch(repairModelSelectionStageCall(fixture).code);
  expect(repaired.evidence).toMatchObject({ errorArgumentsBefore: 3, errorArgumentsAfter: 2, failureLogsAfter: 1, reverseRestoresOriginalBytes: true });
  const logs: string[] = [], inputs: unknown[][] = [];
  const original = new Error("family unavailable");
  const annotated = new Error("ChatGPT multipart_staging_effort_selection failed: family unavailable");
  const scope = { ...context(), Error, console: { info() {}, error(line: string) { logs.push(line); } },
    annotate(error: unknown, stage: string) { inputs.push([error, stage]); return annotated; } };
  const { Worker } = vm.runInNewContext(repaired.code, scope);
  await expect(new Worker().broken({ traceId: "error" }, {}, {}, true, { effortSelection: 1000 }, async () => { throw original; })).rejects.toBe(annotated);
  expect(inputs).toEqual([[original, "multipart_staging_effort_selection"]]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain(annotated.message);
});

test.skipIf(!process.env.CHATGPT_STAGE_CALL_RUNTIME_ROOT)("every runStage call in both candidate bundles has the clock contract and executes with an offline action", async () => {
  const ts = require("typescript");
  const nodes = (root: any, predicate: (node: any) => boolean) => {
    const found: any[] = [];
    const visit = (node: any) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
    visit(root); return found;
  };
  const sourceAudit = assertRunStageCalls(readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8"), "browser-worker.ts");
  for (const relative of ["app/cli.js", "app/browser-helper.cjs"]) {
    const audit = assertRunStageCalls(readFileSync(join(process.env.CHATGPT_STAGE_CALL_RUNTIME_ROOT!, relative), "utf8"), relative);
    expect(audit.calls).toHaveLength(sourceAudit.calls.length);
    for (const argc of [4, 5, 6]) expect(audit.calls.filter((call: any) => call.argc === argc))
      .toHaveLength(sourceAudit.calls.filter((call: any) => call.argc === argc).length);
    const budget = nodes(audit.method, (node: any) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length === 3);
    expect(budget).toHaveLength(1);
    const annotationCalls = nodes(audit.method, (node: any) => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.arguments.length === 2).map((node: any) => node.expression.text);
    const annotation = nodes(audit.source, (node: any) => ts.isFunctionDeclaration(node)
      && (node.name?.text === "chatGptModelSelectionStageError"
        || annotationCalls.includes(node.name?.text) && node.getText(audit.source).includes("chatgpt_model_")));
    expect(annotation).toHaveLength(1);
    const adapter = nodes(annotation[0], (node: any) => ts.isNewExpression(node))[0].expression.getText(audit.source);
    const adapterClass = nodes(audit.source, (node: any) => ts.isClassDeclaration(node) && node.name?.text === adapter);
    expect(adapterClass).toHaveLength(1);
    const persistent = nodes(audit.method, (node: any) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)[0].right.getText(audit.source);
    const vmScope = vm.createContext({ ...context(), Error,
      [audit.clock]: { start() {}, suspendedMs() { return 0; } },
      [budget[0].expression.getText(audit.source)]: (limit: number, elapsed: number, suspended: number) => limit - elapsed + suspended });
    const methodCode = `${adapterClass[0].getText(audit.source)};${annotation[0].getText(audit.source)};
      class ${persistent} extends Error {};
      function __codexSelectionLag20261007(){ return { chatGptModelSelectionStageError }; }
      class Worker { ${audit.method.getText(audit.source)} }; globalThis.worker = new Worker();`;
    vm.runInContext(methodCode, vmScope);
    for (const multipart of [false, true]) {
      for (const call of audit.calls) {
        const labelNode = call.node.arguments[1];
        for (const identifier of nodes(labelNode, (node: any) => ts.isIdentifier(node))) {
          vmScope[identifier.text] = labelNode.kind === ts.SyntaxKind.ConditionalExpression ? multipart : 0;
        }
        let actions = 0;
        vmScope.action = async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); actions++; return "offline-stage"; };
        // Keep the actual label, clock and settlement slots. Browser actions and elapsed budgets are isolated.
        const optional = call.arguments.slice(4).map((argument: string) => "," + argument).join("");
        const invocation = `worker.runStage("offline",${call.arguments[1]},1000,action${optional})`;
        expect(await vm.runInContext(invocation, vmScope)).toBe("offline-stage");
        expect(actions).toBe(1);
      }
    }
    const sourceError = vm.runInContext(`new ${adapter}("family unavailable", {code:"chatgpt_model_family_selection_failed",retryable:true})`, vmScope);
    vmScope.sourceError = sourceError;
    await expect(vm.runInContext('worker.runStage("offline","multipart_staging_effort_selection",1000,async()=>{throw sourceError})', vmScope))
      .rejects.toMatchObject({ code: "chatgpt_model_family_selection_failed", retryable: true, cause: sourceError });
  }
});
