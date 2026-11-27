import assert from "node:assert/strict";
import test from "node:test";
import { computeStripLayout, getFrameCanvasOps } from "../js/strip-renderer.js";

const portraitFrames = Array.from({ length: 4 }, () => ({ width: 780, height: 1040 }));
const landscapeFrames = Array.from({ length: 4 }, () => ({ width: 1040, height: 780 }));

test("strip-4 layout stacks 4 portrait frames vertically within 720px width", () => {
  const layout = computeStripLayout(portraitFrames, "strip-4");
  assert.equal(layout.width, 720);
  assert.equal(layout.slots.length, 4);
  for (let i = 1; i < layout.slots.length; i++) {
    assert.ok(layout.slots[i].y > layout.slots[i - 1].y + layout.slots[i - 1].height);
  }
  assert.ok(layout.height > layout.footerY);
});

test("grid-2x2 layout places 4 frames in 2 columns and 2 rows", () => {
  const layout = computeStripLayout(landscapeFrames, "grid-2x2");
  assert.equal(layout.width, 960);
  assert.equal(layout.slots.length, 4);
  assert.equal(layout.slots[0].y, layout.slots[1].y);
  assert.equal(layout.slots[2].y, layout.slots[3].y);
  assert.ok(layout.slots[1].x > layout.slots[0].x);
  assert.ok(layout.slots[2].y > layout.slots[0].y);
});

test("strip-3 layout caps at 3 frames", () => {
  const layout = computeStripLayout(portraitFrames, "strip-3");
  assert.equal(layout.slots.length, 3);
});

test("getFrameCanvasOps orders rotate before mirror scale so mirrored selfies rotate clockwise", () => {
  assert.deepEqual(getFrameCanvasOps(false, 0), []);
  assert.deepEqual(getFrameCanvasOps(true, 360), [{ type: "scale", sx: -1, sy: 1 }]);
  assert.deepEqual(getFrameCanvasOps(false, 90), [{ type: "rotate", rad: Math.PI / 2 }]);
  assert.deepEqual(getFrameCanvasOps(true, 90), [
    { type: "rotate", rad: Math.PI / 2 },
    { type: "scale", sx: -1, sy: 1 },
  ]);
  assert.deepEqual(getFrameCanvasOps(true, -90), [
    { type: "rotate", rad: (270 * Math.PI) / 180 },
    { type: "scale", sx: -1, sy: 1 },
  ]);
});
