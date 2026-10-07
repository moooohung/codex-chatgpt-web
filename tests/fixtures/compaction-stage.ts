import type { CompiledChatGptWebPrompt } from "../../src/adapters/chatgpt-web/prompt";

/** Decode what the model receives, including the real multipart semantic records. */
export function compactionStageData(compiled: CompiledChatGptWebPrompt): {
  checkpoint: string; fragments: { offset: number; text: string }[];
} {
  const messages = compiled.multipart
    ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records.filter((record: any) => record.kind === "message").map((record: any) => record.message))
    : JSON.parse(compiled.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!).messages;
  const texts: string[] = messages.map((message: any) => typeof message.content === "string" ? message.content
    : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
  const headerText = texts.find(text => text.includes("<codex_compaction_stage_json>\n"))!;
  const header = JSON.parse(headerText.split("<codex_compaction_stage_json>\n")[1]!.split("\n</codex_compaction_stage_json>")[0]!);
  const fragments = header.kind === "source_fragment" ? [{ offset: header.offset, text: header.fragment }]
    : texts.filter(text => text.startsWith("<codex_compaction_source_fragment_json>\n")).map(text => {
      const fragment = JSON.parse(text.split("\n")[1]!); return { offset: fragment.offset, text: fragment.text };
    });
  return { checkpoint: header.previous_checkpoint, fragments };
}
