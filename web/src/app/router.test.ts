import { describe, expect, it } from "vitest";
import { parseRoute } from "./router.ts";

describe("parseRoute", () => {
  it("maps / to home", () => {
    expect(parseRoute("/")).toEqual({ name: "home" });
  });

  it("maps /s/:id to a session", () => {
    expect(parseRoute("/s/abc")).toEqual({ name: "session", id: "abc" });
  });

  it("decodes the id", () => {
    expect(parseRoute("/s/a%2Fb%20c")).toEqual({ name: "session", id: "a/b c" });
  });

  it("tolerates a trailing slash", () => {
    expect(parseRoute("/s/abc/")).toEqual({ name: "session", id: "abc" });
  });

  it("treats an empty id as home", () => {
    expect(parseRoute("/s/")).toEqual({ name: "home" });
    expect(parseRoute("/s///")).toEqual({ name: "home" });
  });

  it("maps /plugins to the plugins page", () => {
    expect(parseRoute("/plugins")).toEqual({ name: "plugins" });
    expect(parseRoute("/plugins/")).toEqual({ name: "plugins" });
    expect(parseRoute("/plugins?x=1")).toEqual({ name: "plugins" });
  });

  it("treats unknown paths as home", () => {
    expect(parseRoute("/whatever")).toEqual({ name: "home" });
    expect(parseRoute("/s")).toEqual({ name: "home" });
    expect(parseRoute("")).toEqual({ name: "home" });
  });

  it("ignores a query string", () => {
    expect(parseRoute("/s/abc?x=1")).toEqual({ name: "session", id: "abc" });
    expect(parseRoute("/?x=1")).toEqual({ name: "home" });
  });

  it("falls back to home on malformed encoding", () => {
    expect(parseRoute("/s/%E0%A4%A")).toEqual({ name: "home" });
  });
});
