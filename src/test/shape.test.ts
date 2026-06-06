import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf, diffShape } from "../shape";

test("shapeOf captures structure, not values", () => {
  assert.deepEqual(shapeOf({ a: 1, b: "x", c: true }), {
    object: { a: "number", b: "string", c: "boolean" },
  });
  assert.equal(JSON.stringify(shapeOf({ b: 1, a: 2 })), JSON.stringify(shapeOf({ a: 9, b: 9 }))); // key order stable
  assert.deepEqual(shapeOf([]), { array: null });
  assert.deepEqual(shapeOf([{ id: 1 }]), { array: { object: { id: "number" } } });
  assert.equal(shapeOf(null), "null");
});

test("identical shapes -> no changes", () => {
  const s = shapeOf({ results: [{ id: 1 }], total: 2 });
  assert.equal(diffShape("r", s, s).length, 0);
});

test("removed field is breaking", () => {
  const a = shapeOf({ results: [], total: 0 });
  const b = shapeOf({ results: [] });
  const c = diffShape("r", a, b);
  assert.ok(c.some((x) => x.severity === "breaking" && /field removed/.test(x.message) && x.path === "r.total"));
});

test("type change is breaking", () => {
  const a = shapeOf({ total: 1 });
  const b = shapeOf({ total: "1" });
  assert.equal(diffShape("r", a, b)[0].severity, "breaking");
});

test("non-empty array going empty is a warning", () => {
  const a = shapeOf({ results: [{ id: 1 }] });
  const b = shapeOf({ results: [] });
  const c = diffShape("r", a, b);
  assert.ok(c.some((x) => x.severity === "warning" && /now empty/.test(x.message)));
});

test("added field is info", () => {
  const a = shapeOf({ total: 1 });
  const b = shapeOf({ total: 1, page: 1 });
  assert.equal(diffShape("r", a, b)[0].severity, "info");
});

test("object becoming array is breaking", () => {
  assert.equal(diffShape("r", shapeOf({ x: 1 }), shapeOf([1]))[0].severity, "breaking");
});
