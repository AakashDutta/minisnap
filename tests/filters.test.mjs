import assert from "node:assert/strict";
import test from "node:test";
import { FILTERS } from "../js/config.js";
import { applyFilterToBuffer, getFilterLUT } from "../js/filters.js";

test("getFilterLUT precomputes bounded 256-entry shadow and highlight tables", () => {
  for (const f of FILTERS) {
    const { shLut, hiLut } = getFilterLUT(f.id);
    assert.equal(shLut.length, 256);
    assert.equal(hiLut.length, 256);
    assert.ok(shLut[0] <= 1.0001 && shLut[255] >= 0);
    assert.ok(hiLut[0] === 0 && hiLut[255] <= 1.0001);
  }
});

test("applyFilterToBuffer produces valid RGBA bytes across all 8 lenses", () => {
  const w = 12;
  const h = 16;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < src.length; i += 4) {
    src[i] = (i * 7) % 256;
    src[i + 1] = (i * 13) % 256;
    src[i + 2] = (i * 19) % 256;
    src[i + 3] = 255;
  }

  for (const f of FILTERS) {
    const out = new Uint8ClampedArray(src.length);
    applyFilterToBuffer(src, out, w, h, f.id);
    for (let i = 0; i < out.length; i += 4) {
      assert.ok(out[i] >= 0 && out[i] <= 255);
      assert.ok(out[i + 1] >= 0 && out[i + 1] <= 255);
      assert.ok(out[i + 2] >= 0 && out[i + 2] <= 255);
      assert.equal(out[i + 3], 255);
      if (f.id === "noir") {
        // Monochrome filter outputs equal or near-equal channels (grain added symmetrically)
        assert.equal(out[i], out[i + 1]);
        assert.equal(out[i + 1], out[i + 2]);
      }
    }
  }
});
