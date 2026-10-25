import { describe, expect, it } from "vitest";
import { synthesizeLegacyRenderParts } from "../composables/assistantRenderParts";
import { mergeSequentialAssistantToolCalls } from "../composables/toolCallBatches";

import type { AssistantRenderPart, ChatMessage, ToolCallInfo } from "../types";

function tool(id: string, order?: number): ToolCallInfo {
  return { id, name: "bash", arguments: "{}", ...(order === undefined ? {} : { order }) };
}

function assistant(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "assistant", content, createdAt: 0, ...extra };
}

function layout(parts: AssistantRenderPart[]) {
  return parts.map((part) => (part.kind === "toolCall" ? part.toolCall.id : part.kind));
}

function expectStrictSeqs(parts: AssistantRenderPart[]) {
  const seqs = parts.map((part) => part.order.seq);
  expect(seqs.every((seq, index) => seq > 0 && (index === 0 || seq > seqs[index - 1]!))).toBe(true);
}

// Rows rebuilt from Claude's native history carry no renderParts and no tool
// orders, so history rendering merges tool-only rows into the next text row.
function renderMerged(messages: ChatMessage[]) {
  return mergeSequentialAssistantToolCalls(messages).map((item) => synthesizeLegacyRenderParts(item, {
    toolCalls: item.displayToolCalls,
    beforeContentToolCalls: item.displayToolCallsBeforeContent,
    afterContentToolCalls: item.displayToolCallsAfterContent,
  }));
}

describe("synthesizeLegacyRenderParts", () => {
  it("keeps every merged earlier tool round before the final text", () => {
    const [parts, ...rest] = renderMerged([
      assistant("write", "", { toolCalls: [tool("t-write")] }),
      assistant("task", "", { toolCalls: [tool("t-task")] }),
      assistant("diff", "", { toolCalls: [tool("t-diff")] }),
      assistant("final", "summary"),
    ]);

    expect(rest).toHaveLength(0);
    expect(layout(parts!)).toEqual(["t-write", "t-task", "t-diff", "text"]);
    expectStrictSeqs(parts!);
  });

  it("places merged earlier tools before the row's own thinking, text and tools", () => {
    const earlier = Array.from({ length: 12 }, (_, index) => assistant(`r${index}`, "", { toolCalls: [tool(`b${index}`)] }));
    const [parts] = renderMerged([
      ...earlier,
      assistant("final", "answer", {
        thinkingContent: "reasoning",
        toolCalls: [tool("own-1"), tool("own-2")],
      }),
    ]);

    expect(layout(parts!)).toEqual([
      ...earlier.map((_, index) => `b${index}`),
      "thinking",
      "text",
      "own-1",
      "own-2",
    ]);
    expectStrictSeqs(parts!);
  });

  it("uses row order for merged tools whose stored orders come from another run", () => {
    const parts = synthesizeLegacyRenderParts(assistant("final", "answer", { contentOrder: 3 }), {
      beforeContentToolCalls: [tool("first", 40), tool("second", 2)],
    });

    expect(layout(parts)).toEqual(["first", "second", "text"]);
    expectStrictSeqs(parts);
  });

  it("keeps ordered rows without merged tools on their recorded sequence", () => {
    const parts = synthesizeLegacyRenderParts(assistant("live", "after tools", {
      thinkingOrder: 3,
      contentOrder: 6,
      thinkingContent: "reasoning",
      toolCalls: [tool("t1", 4), tool("t2", 5)],
    }));

    expect(parts.map((part) => [part.kind, part.order.seq])).toEqual([
      ["thinking", 3],
      ["toolCall", 4],
      ["toolCall", 5],
      ["text", 6],
    ]);
  });

  it("puts knowledge proposals after every tool call of the message", () => {
    const proposal = assistant("proposal", "", {
      knowledgeProposal: {} as NonNullable<ChatMessage["knowledgeProposal"]>,
    });
    const toolCalls = Array.from({ length: 120 }, (_, index) => tool(`t${index}`));
    const parts = synthesizeLegacyRenderParts(assistant("final", "answer"), {
      afterContentToolCalls: toolCalls,
      knowledgeProposals: [proposal],
    });

    expect(layout(parts)[parts.length - 1]).toBe("knowledgeProposal");
    expectStrictSeqs(parts);
  });
});
