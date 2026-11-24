import assert from "node:assert/strict";
import test from "node:test";
import { extractImages, sniffFormat } from "../src/sources/images.mjs";
import { recordsFromJsonLine } from "../src/transcripts.mjs";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_HEADER, Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);

function claudeImageLine(source, { type = "user" } = {}) {
  return JSON.stringify({
    type,
    uuid: "uuid-image",
    message: { role: "user", content: [{ type: "image", source }] },
  });
}

test("identifies formats from magic bytes rather than declared media types", () => {
  assert.equal(sniffFormat(PNG), "png");
  assert.equal(sniffFormat(JPEG), "jpeg");
  assert.equal(sniffFormat(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "webp");
  assert.equal(sniffFormat(Buffer.from("not an image at all")), null);
});

test("reads a base64 image out of a Claude user record", () => {
  const records = recordsFromJsonLine(
    claudeImageLine({ type: "base64", media_type: "image/png", data: PNG.toString("base64") }),
    "claude",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "image");
  assert.equal(records[0].mediaType, "image/png");

  const [item] = extractImages(records[0]);
  assert.equal(item.format, "png");
  assert.ok(item.bytes.equals(PNG));
  assert.match(item.type, /^png /u);
});

test("trusts the bytes when the harness omits media_type", () => {
  const records = recordsFromJsonLine(
    claudeImageLine({ type: "base64", data: JPEG.toString("base64") }),
    "claude",
  );

  assert.equal(records[0].mediaType, null);
  assert.equal(extractImages(records[0])[0].format, "jpeg");
});

test("ignores image blocks whose payload was elided on compaction", () => {
  assert.deepEqual(recordsFromJsonLine(claudeImageLine({}), "claude"), []);
  assert.deepEqual(
    recordsFromJsonLine(claudeImageLine({ type: "base64", data: "" }), "claude"),
    [],
  );
});

test("reads an image nested inside a tool result", () => {
  // How every screenshot the agent takes reaches the transcript: the image is
  // a child of the tool_result block, not a sibling of it.
  const line = JSON.stringify({
    type: "user",
    uuid: "uuid-tool",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "Read image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
          ],
        },
      ],
    },
  });

  const records = recordsFromJsonLine(line, "claude");
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "uuid-tool:0.1");
  assert.equal(extractImages(records[0])[0].format, "png");
});

test("reads images from attachment records too", () => {
  const records = recordsFromJsonLine(
    claudeImageLine(
      { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
      { type: "attachment" },
    ),
    "claude",
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "image");
});

test("reads a Codex data-URL image", () => {
  const line = JSON.stringify({
    type: "response_item",
    payload: {
      id: "msg_9",
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}` },
      ],
    },
  });

  const records = recordsFromJsonLine(line, "codex");
  assert.equal(records.length, 1);
  assert.equal(extractImages(records[0])[0].format, "png");
});

test("does not treat assistant prose as an image", () => {
  assert.deepEqual(extractImages({ kind: "text", id: "a:0", text: "![alt](x.png)" }), []);
});

test("rejects payloads that decode to something that is not an image", () => {
  const record = { kind: "image", id: "x:0", data: Buffer.from("hello there").toString("base64") };
  assert.deepEqual(extractImages(record), []);
});

test("gives identical images one identity so a redraw is not a new item", () => {
  const record = { kind: "image", id: "x:0", data: PNG.toString("base64") };
  const other = { kind: "image", id: "y:1", data: PNG.toString("base64") };
  assert.equal(extractImages(record)[0].hash, extractImages(other)[0].hash);
});
