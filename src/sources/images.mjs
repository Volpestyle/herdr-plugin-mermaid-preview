import { createHash } from "node:crypto";

/**
 * Images carried by the transcript itself.
 *
 * Unlike Mermaid, nothing has to be reconstructed from Markdown: both harnesses
 * store image content blocks as base64, so what you paste into a session and
 * what the agent looked at with its read tool are already sitting in the JSONL.
 * The source's whole job is to recognise them and name their format.
 */

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

const SIGNATURES = [
  { format: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { format: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { format: "bmp", bytes: [0x42, 0x4d] },
];

/**
 * The format, taken from the bytes rather than the declared media type.
 *
 * media_type is absent often enough to matter, and a wrong one would send a
 * JPEG down the PNG passthrough and produce a terminal full of garbage.
 */
export function sniffFormat(head) {
  for (const { bytes, format } of SIGNATURES) {
    if (head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte)) {
      return format;
    }
  }
  // RIFF....WEBP — the size field sits between the two markers.
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export function imageHash(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * One preview item per usable image record. Decoding happens here, once, so a
 * malformed payload fails at extraction rather than halfway through a redraw.
 */
export function extractImages(record) {
  if (record?.kind !== "image" || typeof record.data !== "string") return [];

  let bytes;
  try {
    bytes = Buffer.from(record.data, "base64");
  } catch {
    return [];
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return [];

  const format = sniffFormat(bytes);
  if (!format) return [];

  return [
    {
      bytes,
      format,
      hash: imageHash(bytes),
      type: `${format} ${describeSize(bytes.length)}`,
    },
  ];
}

function describeSize(byteLength) {
  if (byteLength >= 1024 * 1024) return `${(byteLength / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(byteLength / 1024))}KB`;
}
