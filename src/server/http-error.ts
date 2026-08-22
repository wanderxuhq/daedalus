// src/server/http-error.ts
// 从 anther server/http-error.ts 移植。唯一改动：参数属性（parameter property）在
// daedalus 的 erasableSyntaxOnly 下不允许（TS1294），改为显式字段声明 + 赋值。
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// res.json 辅助（挂在原型上，路由层直接用）
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
