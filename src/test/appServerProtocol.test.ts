import assert from "node:assert/strict";
import test from "node:test";

import {
  completedAgentMessage,
  completedTurn,
  parseRpcMessage,
  threadIdFromStartResult,
  turnIdFromStartResult
} from "../appServerProtocol.js";

test("RPC parser accepts responses and rejects malformed input", () => {
  assert.deepEqual(parseRpcMessage('{"id":7,"result":{"ok":true}}'), {
    kind: "response",
    id: 7,
    result: { ok: true }
  });
  assert.equal(parseRpcMessage("not-json"), undefined);
});

test("thread and turn ids are extracted from start results", () => {
  assert.equal(threadIdFromStartResult({ thread: { id: "thread-1" } }), "thread-1");
  assert.equal(turnIdFromStartResult({ turn: { id: "turn-1" } }), "turn-1");
});

test("completed agent messages include their routing ids", () => {
  assert.deepEqual(completedAgentMessage({
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: '{"completion":"answer"}' }
  }), {
    threadId: "thread-1",
    turnId: "turn-1",
    text: '{"completion":"answer"}'
  });
});

test("completed turns surface status and errors", () => {
  assert.deepEqual(completedTurn({
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "failed",
      error: { message: "model unavailable" }
    }
  }), {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "failed",
    errorMessage: "model unavailable"
  });
});
