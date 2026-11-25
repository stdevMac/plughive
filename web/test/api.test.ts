import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  CSRF_HEADER,
  createApi,
  errorMessage,
  getSession,
  takeTokenFromLocation,
} from "../src/lib/api";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, impl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const headersOf = (c: Call | undefined) => (c?.init?.headers ?? {}) as Record<string, string>;

describe("createApi", () => {
  it("returns parsed JSON and builds the query string, skipping empty values", async () => {
    const f = fakeFetch(() => json(200, { ok: true, n: 1 }));
    const api = createApi(f.impl);
    expect(
      await api.get("/api/usage", {
        since: "2026-01-01",
        limit: 5,
        kind: "",
        x: undefined,
        y: null,
      }),
    ).toEqual({ ok: true, n: 1 });
    expect(f.calls[0]?.url).toBe("/api/usage?since=2026-01-01&limit=5");
    expect(f.calls[0]?.init?.credentials).toBe("same-origin");
  });

  it("sends the CSRF header and a JSON body on writes only", async () => {
    const f = fakeFetch(() => json(200, { ok: true }));
    const api = createApi(f.impl);
    await api.get("/api/packs");
    await api.post("/api/profiles", { name: "a" });
    await api.del("/api/profiles/a");
    expect(headersOf(f.calls[0])[CSRF_HEADER]).toBeUndefined();
    expect(headersOf(f.calls[1])[CSRF_HEADER]).toBe("1");
    expect(headersOf(f.calls[1])["Content-Type"]).toBe("application/json");
    expect(f.calls[1]?.init?.body).toBe('{"name":"a"}');
    expect(f.calls[2]?.init?.method).toBe("DELETE");
    expect(headersOf(f.calls[2])[CSRF_HEADER]).toBe("1");
  });

  it("turns the daemon's error shape into an ApiError with code, issues and details", async () => {
    const f = fakeFetch(() =>
      json(400, {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Bad input",
          issues: [{ path: "name", message: "is required" }],
          pack: "fal",
        },
      }),
    );
    const err = (await createApi(f.impl)
      .post("/api/profiles", {})
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("Bad input");
    expect(err.issues).toEqual([{ path: "name", message: "is required" }]);
    expect(err.details).toEqual({ pack: "fal" });
    expect(err.isNetwork).toBe(false);
    expect(errorMessage(err)).toBe("Bad input: name is required");
  });

  it("treats ok:false with HTTP 200 as an error", async () => {
    const f = fakeFetch(() => json(200, { ok: false, error: { code: "NOPE", message: "No" } }));
    await expect(createApi(f.impl).get("/x")).rejects.toMatchObject({ code: "NOPE", status: 200 });
  });

  it("falls back to a plain message when the body is not JSON", async () => {
    const f = fakeFetch(() => new Response("<html>oops</html>", { status: 502 }));
    await expect(createApi(f.impl).get("/x")).rejects.toMatchObject({
      code: "HTTP_502",
      message: "The daemon hit an internal error.",
    });
    const g = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(createApi(g.impl).get("/x")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("reports a network failure as status 0", async () => {
    const api = createApi(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = (await api.get("/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isNetwork).toBe(true);
    expect(err.code).toBe("NETWORK");
  });

  it("passes aborts through untouched", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const api = createApi(async () => {
      throw abort;
    });
    await expect(api.get("/x")).rejects.toBe(abort);
  });

  it("calls 401 listeners until they unsubscribe", async () => {
    const f = fakeFetch(() =>
      json(401, { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in" } }),
    );
    const api = createApi(f.impl);
    const listener = vi.fn();
    const off = api.onUnauthorized(listener);
    await api.get("/api/packs").catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await api.get("/api/packs").catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("session", () => {
  it("reads the session state", async () => {
    const yes = createApi(fakeFetch(() => json(200, { ok: true, authenticated: true })).impl);
    expect(await getSession(yes)).toEqual({ authenticated: true, supported: true });
    const no = createApi(
      fakeFetch(() => json(401, { ok: false, error: { code: "UNAUTHORIZED", message: "x" } })).impl,
    );
    expect(await getSession(no)).toEqual({ authenticated: false, supported: true });
  });

  it("treats a daemon without the session API as signed in", async () => {
    const old = createApi(
      fakeFetch(() => json(404, { ok: false, error: { code: "NOT_FOUND", message: "x" } })).impl,
    );
    expect(await getSession(old)).toEqual({ authenticated: true, supported: false });
  });

  it("rethrows other failures", async () => {
    const down = createApi(fakeFetch(() => json(500, {})).impl);
    await expect(getSession(down)).rejects.toBeInstanceOf(ApiError);
  });

  it("takes the token from the fragment and removes it", () => {
    const replace = vi.fn();
    expect(
      takeTokenFromLocation(
        { hash: "#token=abc&tab=x", pathname: "/packs", search: "?a=1" },
        replace,
      ),
    ).toBe("abc");
    expect(replace).toHaveBeenCalledWith("/packs?a=1#tab=x");
    const none = vi.fn();
    expect(takeTokenFromLocation({ hash: "", pathname: "/", search: "" }, none)).toBeNull();
    expect(none).not.toHaveBeenCalled();
  });
});
