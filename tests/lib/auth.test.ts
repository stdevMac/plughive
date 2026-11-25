import type { Request, Response } from "express";
// tests/lib/auth.test.ts
import { describe, expect, it, vi } from "vitest";
import { accessKeyMiddleware } from "../../src/lib/auth.js";

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: unknown };
}

describe("accessKeyMiddleware", () => {
  it("passes through when no access key configured", () => {
    const mw = accessKeyMiddleware({ accessKey: null });
    const next = vi.fn();
    mw({ header: () => undefined } as unknown as Request, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects missing keys with 401", () => {
    const mw = accessKeyMiddleware({ accessKey: "secret" });
    const next = vi.fn();
    const res = mockRes();
    mw({ header: () => undefined } as unknown as Request, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "invalid or missing access key" },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects wrong keys", () => {
    const mw = accessKeyMiddleware({ accessKey: "secret" });
    const next = vi.fn();
    const res = mockRes();
    const req = {
      header: (h: string) => (h === "authorization" ? "Bearer nope" : undefined),
    } as unknown as Request;
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts bearer tokens", () => {
    const mw = accessKeyMiddleware({ accessKey: "secret" });
    const next = vi.fn();
    const req = {
      header: (h: string) => (h === "authorization" ? "Bearer secret" : undefined),
    } as unknown as Request;
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("accepts X-API-Key", () => {
    const mw = accessKeyMiddleware({ accessKey: "secret" });
    const next = vi.fn();
    const req = {
      header: (h: string) => (h === "x-api-key" ? "secret" : undefined),
    } as unknown as Request;
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("ignores query parameters", () => {
    const mw = accessKeyMiddleware({ accessKey: "secret" });
    const next = vi.fn();
    const res = mockRes();
    const req = { header: () => undefined, query: { api_key: "secret" } } as unknown as Request;
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
