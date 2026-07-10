import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteAllKittyImages,
  encodeKittyPng,
  fitImageCells,
  pngDimensions,
  zoomedImagePlacement,
} from "../src/kitty.mjs";

function fakePng(width, height, payloadBytes = 0) {
  const png = Buffer.alloc(24 + payloadBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test("reads PNG dimensions", () => {
  assert.deepEqual(pngDimensions(fakePng(1600, 900)), { width: 1600, height: 900 });
  assert.throws(() => pngDimensions(Buffer.from("nope")), /valid PNG/u);
});

test("fits image dimensions into terminal cells without stretching", () => {
  assert.deepEqual(
    fitImageCells({ width: 1600, height: 900 }, { columns: 100, rows: 30 }),
    { columns: 100, rows: 28 },
  );
  assert.deepEqual(
    fitImageCells({ width: 900, height: 1600 }, { columns: 100, rows: 30 }),
    { columns: 34, rows: 30 },
  );
});

test("encodes chunked Kitty PNG transmission and deletion", () => {
  const encoded = encodeKittyPng(fakePng(100, 50, 8_000), {
    columns: 40,
    imageId: 42,
    rows: 20,
  });
  assert.match(encoded, /a=T,f=100,t=d,q=2,i=42,c=40,r=20,m=1/u);
  assert.match(encoded, /\u001b_Gm=0;/u);
  assert.equal(deleteAllKittyImages(), "\u001b_Ga=d,d=A,q=2;\u001b\\");
});

test("turns zoom and pan into a bounded Kitty source rectangle", () => {
  assert.deepEqual(
    zoomedImagePlacement(
      { width: 1600, height: 900 },
      { columns: 100, rows: 30 },
      { panX: 0.5, panY: 0.5, zoom: 2 },
    ),
    {
      columns: 100,
      rows: 30,
      sourceHeight: 482,
      sourceWidth: 800,
      sourceX: 400,
      sourceY: 209,
    },
  );

  const panned = zoomedImagePlacement(
    { width: 1600, height: 900 },
    { columns: 100, rows: 30 },
    { panX: 2, panY: -1, zoom: 2 },
  );
  assert.equal(panned.sourceX + panned.sourceWidth, 1600);
  assert.equal(panned.sourceY, 0);
});

test("includes a source rectangle in Kitty image placement controls", () => {
  const encoded = encodeKittyPng(fakePng(100, 50), {
    columns: 40,
    imageId: 42,
    rows: 20,
    sourceHeight: 25,
    sourceWidth: 50,
    sourceX: 10,
    sourceY: 5,
  });
  assert.match(encoded, /c=40,r=20,x=10,y=5,w=50,h=25,m=0/u);
});
