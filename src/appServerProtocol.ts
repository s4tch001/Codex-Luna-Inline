export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}

export type RpcMessage =
  | { readonly kind: "response"; readonly id: number; readonly result: JsonValue }
  | { readonly kind: "error"; readonly id: number; readonly error: RpcError }
  | { readonly kind: "notification"; readonly method: string; readonly params: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringProperty(value: JsonValue, property: string): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : undefined;
}

export function objectProperty(value: JsonValue, property: string): JsonObject | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const candidate = value[property];
  return isJsonObject(candidate) ? candidate : undefined;
}

function parseError(value: unknown): RpcError | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const code = value.code;
  const message = value.message;
  if (typeof code !== "number" || typeof message !== "string") {
    return undefined;
  }
  return value.data === undefined
    ? { code, message }
    : { code, message, data: value.data };
}

export function parseRpcMessage(line: string): RpcMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) {
    return undefined;
  }

  if (typeof parsed.id === "number") {
    const error = parseError(parsed.error);
    if (error !== undefined) {
      return { kind: "error", id: parsed.id, error };
    }
    if (parsed.result !== undefined) {
      return { kind: "response", id: parsed.id, result: parsed.result };
    }
  }

  if (typeof parsed.method === "string") {
    return {
      kind: "notification",
      method: parsed.method,
      params: parsed.params ?? null
    };
  }

  return undefined;
}

export function threadIdFromStartResult(result: JsonValue): string | undefined {
  const thread = objectProperty(result, "thread");
  return thread === undefined ? undefined : stringProperty(thread, "id");
}

export function turnIdFromStartResult(result: JsonValue): string | undefined {
  const turn = objectProperty(result, "turn");
  return turn === undefined ? undefined : stringProperty(turn, "id");
}

export interface CompletedAgentMessage {
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
}

export function completedAgentMessage(params: JsonValue): CompletedAgentMessage | undefined {
  const threadId = stringProperty(params, "threadId");
  const turnId = stringProperty(params, "turnId");
  const item = objectProperty(params, "item");
  if (
    threadId === undefined
    || turnId === undefined
    || item === undefined
    || stringProperty(item, "type") !== "agentMessage"
  ) {
    return undefined;
  }
  const text = stringProperty(item, "text");
  return text === undefined ? undefined : { threadId, turnId, text };
}

export interface CompletedTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "completed" | "interrupted" | "failed" | "unknown";
  readonly errorMessage: string | undefined;
}

export function completedTurn(params: JsonValue): CompletedTurn | undefined {
  const threadId = stringProperty(params, "threadId");
  const turn = objectProperty(params, "turn");
  const turnId = turn === undefined ? undefined : stringProperty(turn, "id");
  if (threadId === undefined || turn === undefined || turnId === undefined) {
    return undefined;
  }

  const rawStatus = stringProperty(turn, "status");
  const status = rawStatus === "completed" || rawStatus === "interrupted" || rawStatus === "failed"
    ? rawStatus
    : "unknown";
  const error = objectProperty(turn, "error");
  return {
    threadId,
    turnId,
    status,
    errorMessage: error === undefined ? undefined : stringProperty(error, "message")
  };
}
