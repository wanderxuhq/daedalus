// src/server/http-error.ts
// Ported from anther server/http-error.ts. Only change: parameter properties are disallowed
// under daedalus's erasableSyntaxOnly (TS1294), so switched to explicit field declaration + assignment.
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// res.json helper (attached to prototype, used directly in route layer)
import { ServerResponse } from 'node:http';
declare module 'node:http' {
  interface ServerResponse {
    json(data: unknown, status?: number): void;
  }
}
ServerResponse.prototype.json = function (data: unknown, status = 200) {
  const body = JSON.stringify(data);
  this.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  this.end(body);
};
