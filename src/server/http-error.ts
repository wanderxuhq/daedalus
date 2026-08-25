// src/server/http-error.ts
// Ported from anther server/http-error.ts. Only change: parameter properties are disallowed
// under daedalus's erasableSyntaxOnly (TS1294), so switched to explicit field declaration + assignment.
import type { ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Send a JSON response. Standalone function — does not monkey-patch any prototype. */
export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
