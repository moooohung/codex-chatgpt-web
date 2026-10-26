import { expect, test } from "bun:test";
import { assertChatGptModelFamily, chatGptEffortOnlyEvidenceMatches, chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";
import { chatGptUsageModelFromAnnouncements } from "../src/adapters/chatgpt-web/limits";

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true], ["6", true],
    ["GPT-5.6 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test("family confirmation verifies the exact Sol or Pro version, including the old Latest picker", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Medium, 2 of 3.", "Medium"], "6", "medium")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6.1 High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
});

test("model selection recognizes 5.6 and (Web) suffixes in Korean and English", async () => {
  for (const [label, accepted] of [
    ["GPT-5.6 Sol", true], ["GPT-5.6 Sol (Web)", true], ["GPT-5.6 Sol (웹)", true],
    ["GPT 5.6", true], ["GPT-5.6 Sol Pro", true], ["GPT-6 Astra", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "5.6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});


test.each(["5.6 Sol Instant", "6 Pro", ""])("generic effort announcements require matching active model evidence: %s", async header => {
  const menu = {
    menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test("GPT-5.6 Sol") ? 1 : 0,
        getAttribute: async () => "true",
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    },
    slider: {
      getAttribute: async (attr: string) => {
        if (attr === "aria-valuemin") return "0";
        if (attr === "aria-valuemax") return "2";
        if (attr === "aria-valuenow") return "0";
        return null;
      },
      evaluate: async () => ["Instant, 1 of 3.", "Use Left and Right arrow keys to adjust power", header],
    },
  } as unknown as Parameters<typeof assertChatGptModelFamily>[0];

  const confirmation = assertChatGptModelFamily(menu, "5.6", "low", 0);
  if (header === "5.6 Sol Instant") await confirmation;
  else await expect(confirmation).rejects.toThrow("could not be selected and verified");
});
test("Simplified Chinese effort announcements preserve exact model and effort verification (#911)", () => {
  for (const [label, effort] of [["即时", "low"], ["中", "medium"], ["高", "high"]] as const) {
    expect(chatGptModelFamilyMatches([`GPT-6 Sol ${label}，第 3 项，共 3 项`, `6 ${label}`], "6", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches([`5.6 ${label}`], "6", effort)).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Astra ${label}`], "6", effort)).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 ${label}`, "6 Pro"], "6", effort)).toBeFalse();
  }
  for (const effort of ["low", "medium", "xhigh", "max"] as const) {
    expect(chatGptModelFamilyMatches(["6 高"], "6", effort)).toBeFalse();
  }
  for (const label of ["超高", "高级", "高 reasoning", "高 6.1"]) {
    expect(chatGptModelFamilyMatches([`6 ${label}`], "6", "high")).toBeFalse();
  }
});


test("model verification accepts Unicode announcement punctuation without weakening identity", () => {
  for (const separator of ["、", "，", "،", "؛", "：", "—", "。", ",", ";"]) {
    expect(chatGptModelFamilyMatches([`6 Pro${separator}5 件中 5 番目。`], "6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`GPT-5.6 Sol Pro${separator}translated position`], "5.6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`6.1 Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Sol Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Pro${separator}position`, "5.6 Pro"], "6", "max")).toBeFalse();
  }
  expect(chatGptModelFamilyMatches(["\u2068６ Pro\u2069、position"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Pro for better answers"], "6", "max")).toBeFalse();
});

test("repeated picker version verifies GPT-5.6 Pro without accepting conflicting evidence (#875)", () => {
  for (const header of ["5.6 Sol 5.6 Pro", "GPT-5.6 Sol GPT-5.6 Pro"]) {
    const evidence = ["5.6 Pro, 5 of 5.", header];
    expect(chatGptModelFamilyMatches(evidence, "5.6", "max")).toBeTrue();
    expect(chatGptUsageModelFromAnnouncements(evidence)).toBe("gpt-5.6-pro");
    expect(chatGptModelFamilyMatches(evidence, "5.6", "high")).toBeFalse();
    expect(chatGptModelFamilyMatches(evidence, "6", "max")).toBeFalse();
  }
  for (const header of ["5.6 Sol 6 Pro", "5.6 Sol 5.7 Pro", "5.6 Sol 5.6.1 Pro"]) {
    expect(chatGptModelFamilyMatches(["5.6 Pro, 5 of 5.", header], "5.6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([header], "5.6", "high")).toBeFalse();
    expect(chatGptUsageModelFromAnnouncements([header])).toBe("pro-unknown");
  }
  expect(chatGptModelFamilyMatches(["6 Astra 6 Pro"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Astra 6 Pro"], "6", "high")).toBeFalse();
});

test("Plus effort-only announcements prove only an explicitly checked 5.6 row", () => {
  // Live Plus picker 2026-10-21: header "Medium", slider "Medium, 2 of 4.", no version.
  expect(chatGptEffortOnlyEvidenceMatches(["Medium", "Medium, 2 of 4."], "5.6", "medium")).toBe(true);
  expect(chatGptEffortOnlyEvidenceMatches(["Extra High, 4 of 4."], "5.6", "xhigh")).toBe(true);
  expect(chatGptEffortOnlyEvidenceMatches(["Medium", "Medium, 2 of 4."], "6", "medium")).toBe(false);
  expect(chatGptEffortOnlyEvidenceMatches(["High, 3 of 4."], "5.6", "medium")).toBe(false);
  expect(chatGptEffortOnlyEvidenceMatches(["Medium", "6 Medium, 2 of 3."], "5.6", "medium")).toBe(false);
  expect(chatGptEffortOnlyEvidenceMatches([], "5.6", "medium")).toBe(false);
  expect(chatGptEffortOnlyEvidenceMatches(["Try Pro for more reasoning"], "5.6", "medium")).toBe(false);
});