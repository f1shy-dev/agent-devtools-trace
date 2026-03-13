import type { Session } from "../../shared/types";

interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  priority?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  statusCode?: number;
  mimeType?: string;
  encodedDataLength?: number;
  decodedBodyLength?: number;
  fromCache?: boolean;
  initiator?: { type: string; url?: string };
}

function getData(event: { args?: Record<string, any> }): Record<string, any> {
  if (event.args && typeof event.args.data === "object" && event.args.data !== null) {
    return event.args.data as Record<string, any>;
  }

  return {};
}

function getOrCreateRequest(
  requests: Map<string, NetworkRequest>,
  requestId: string,
  startTime = 0,
): NetworkRequest {
  const existing = requests.get(requestId);
  if (existing) {
    return existing;
  }

  const request: NetworkRequest = {
    requestId,
    url: "",
    method: "",
    startTime,
  };
  requests.set(requestId, request);
  return request;
}

export async function getNetwork(session: Session): Promise<{ requests: NetworkRequest[] }> {
  const requests = new Map<string, NetworkRequest>();

  for (const event of session.indexes.byName.get("ResourceSendRequest") ?? []) {
    const data = getData(event);
    if (typeof data.requestId !== "string" || data.requestId.length === 0) {
      continue;
    }

    const request = getOrCreateRequest(requests, data.requestId, event.ts);
    request.startTime = event.ts;
    request.url = typeof data.url === "string" ? data.url : request.url;
    request.method = typeof data.requestMethod === "string" ? data.requestMethod : request.method;
    request.resourceType =
      typeof data.resourceType === "string" ? data.resourceType : request.resourceType;
    request.priority = typeof data.priority === "string" ? data.priority : request.priority;
    if (typeof data.fromCache === "boolean") {
      request.fromCache = data.fromCache;
    }
    if (typeof data.initiator?.type === "string") {
      request.initiator = {
        type: data.initiator.type,
        url: typeof data.initiator.url === "string" ? data.initiator.url : undefined,
      };
    }
  }

  for (const event of session.indexes.byName.get("ResourceReceiveResponse") ?? []) {
    const data = getData(event);
    if (typeof data.requestId !== "string" || data.requestId.length === 0) {
      continue;
    }

    const request = getOrCreateRequest(requests, data.requestId);
    if (typeof data.statusCode === "number") {
      request.statusCode = data.statusCode;
    }
    if (typeof data.mimeType === "string") {
      request.mimeType = data.mimeType;
    }
    if (typeof data.fromCache === "boolean") {
      request.fromCache = data.fromCache;
    }
  }

  for (const event of session.indexes.byName.get("ResourceFinish") ?? []) {
    const data = getData(event);
    if (typeof data.requestId !== "string" || data.requestId.length === 0) {
      continue;
    }

    const request = getOrCreateRequest(requests, data.requestId);
    request.endTime = event.ts + (event.dur ?? 0);
    if (request.startTime > 0) {
      request.duration = (request.endTime - request.startTime) / 1000;
    }
    if (typeof data.encodedDataLength === "number") {
      request.encodedDataLength = data.encodedDataLength;
    }
    if (typeof data.decodedBodyLength === "number") {
      request.decodedBodyLength = data.decodedBodyLength;
    }
    if (typeof data.fromCache === "boolean") {
      request.fromCache = data.fromCache;
    }
  }

  return {
    requests: [...requests.values()].sort(
      (left, right) =>
        left.startTime - right.startTime || left.requestId.localeCompare(right.requestId),
    ),
  };
}
