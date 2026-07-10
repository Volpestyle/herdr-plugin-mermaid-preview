const KITTY_START = "\u001b_G";
const KITTY_END = "\u001b\\";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngDimensions(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Mermaid renderer did not produce a valid PNG");
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

export function fitImageCells(image, bounds, cellAspect = 0.5) {
  const maxColumns = Math.max(1, Math.floor(bounds.columns));
  const maxRows = Math.max(1, Math.floor(bounds.rows));
  const targetColumnRowRatio = image.width / image.height / cellAspect;

  let columns = maxColumns;
  let rows = Math.max(1, Math.round(columns / targetColumnRowRatio));
  if (rows > maxRows) {
    rows = maxRows;
    columns = Math.max(1, Math.round(rows * targetColumnRowRatio));
  }

  return {
    columns: Math.min(columns, maxColumns),
    rows: Math.min(rows, maxRows),
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function zoomedImagePlacement(
  image,
  bounds,
  { panX = 0.5, panY = 0.5, zoom = 1 } = {},
  cellAspect = 0.5,
) {
  const safeZoom = Math.max(1, Number.isFinite(zoom) ? zoom : 1);
  const base = fitImageCells(image, bounds, cellAspect);
  const fullColumns = base.columns * safeZoom;
  const fullRows = base.rows * safeZoom;
  const columns = Math.max(1, Math.min(Math.floor(bounds.columns), Math.round(fullColumns)));
  const rows = Math.max(1, Math.min(Math.floor(bounds.rows), Math.round(fullRows)));
  const sourceWidth = Math.max(1, Math.min(image.width, Math.round(image.width * columns / fullColumns)));
  const sourceHeight = Math.max(1, Math.min(image.height, Math.round(image.height * rows / fullRows)));
  const sourceX = Math.round((image.width - sourceWidth) * clamp(panX, 0, 1));
  const sourceY = Math.round((image.height - sourceHeight) * clamp(panY, 0, 1));

  return { columns, rows, sourceHeight, sourceWidth, sourceX, sourceY };
}

export function deleteAllKittyImages() {
  return `${KITTY_START}a=d,d=A,q=2;${KITTY_END}`;
}

export function encodeKittyPng(
  png,
  {
    columns,
    imageId = 1,
    rows,
    sourceHeight,
    sourceWidth,
    sourceX,
    sourceY,
  },
) {
  pngDimensions(png);
  const base64 = png.toString("base64");
  const chunks = base64.match(/.{1,4096}/gu) || [""];
  const sourceRectangle = [sourceX, sourceY, sourceWidth, sourceHeight].every(Number.isFinite)
    ? `,x=${Math.round(sourceX)},y=${Math.round(sourceY)},w=${Math.round(sourceWidth)},h=${Math.round(sourceHeight)}`
    : "";

  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;
      const controls =
        index === 0
          ? `a=T,f=100,t=d,q=2,i=${imageId},c=${columns},r=${rows}${sourceRectangle},m=${more}`
          : `m=${more}`;
      return `${KITTY_START}${controls};${chunk}${KITTY_END}`;
    })
    .join("");
}
