import { test } from "node:test";
import assert from "node:assert/strict";
import { diffInputSchema, worstSeverity } from "../schema-diff";

const base = {
  type: "object",
  properties: { q: { type: "string" }, limit: { type: "number" } },
  required: ["q"],
};

test("identical schemas produce no changes", () => {
  assert.equal(diffInputSchema("search", base, base).length, 0);
});

test("optional -> required is breaking", () => {
  const next = { ...base, required: ["q", "limit"] };
  const c = diffInputSchema("search", base, next);
  assert.equal(c.length, 1);
  assert.equal(c[0].severity, "breaking");
  assert.match(c[0].message, /became required/);
});

test("required -> optional is a warning", () => {
  const next = { ...base, required: [] as string[] };
  const c = diffInputSchema("search", base, next);
  assert.equal(c[0].severity, "warning");
});

test("removed property is breaking", () => {
  const next = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  const c = diffInputSchema("search", base, next);
  assert.ok(c.some((x) => x.severity === "breaking" && /property removed/.test(x.message)));
});

test("new optional property is info; new required is breaking", () => {
  const addOptional = {
    ...base,
    properties: { ...base.properties, page: { type: "number" } },
  };
  assert.equal(diffInputSchema("search", base, addOptional)[0].severity, "info");

  const addRequired = { ...addOptional, required: ["q", "page"] };
  assert.ok(diffInputSchema("search", base, addRequired).some((x) => x.severity === "breaking"));
});

test("type change is breaking", () => {
  const next = {
    ...base,
    properties: { ...base.properties, limit: { type: "string" } },
  };
  const c = diffInputSchema("search", base, next);
  assert.ok(c.some((x) => x.severity === "breaking" && /type changed/.test(x.message)));
});

test("enum narrowing is breaking, widening is info", () => {
  const withEnum = {
    type: "object",
    properties: { mode: { type: "string", enum: ["a", "b"] } },
    required: [] as string[],
  };
  const narrowed = {
    type: "object",
    properties: { mode: { type: "string", enum: ["a"] } },
    required: [] as string[],
  };
  assert.ok(diffInputSchema("t", withEnum, narrowed).some((x) => x.severity === "breaking"));

  const widened = {
    type: "object",
    properties: { mode: { type: "string", enum: ["a", "b", "c"] } },
    required: [] as string[],
  };
  const c = diffInputSchema("t", withEnum, widened);
  assert.equal(c.length, 1);
  assert.equal(c[0].severity, "info");
});

test("worstSeverity picks the highest", () => {
  assert.equal(worstSeverity([]), null);
  assert.equal(
    worstSeverity([
      { severity: "info", path: "a", message: "" },
      { severity: "breaking", path: "b", message: "" },
      { severity: "warning", path: "c", message: "" },
    ]),
    "breaking",
  );
});
