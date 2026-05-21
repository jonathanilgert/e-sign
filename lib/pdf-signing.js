let pdfjsPromise;
function getPdfJs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const DEFAULT_SIGNATURE_WIDTH = 240;
const DEFAULT_SIGNATURE_HEIGHT = 50;
const DEFAULT_TEXT_WIDTH = 240;
const DEFAULT_TEXT_HEIGHT = 20;
const DEFAULT_INITIALS_WIDTH = 100;
const DEFAULT_INITIALS_HEIGHT = 18;

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function getPdfPageSizes(pdfBytes) {
  const pdfjs = await getPdfJs();
  const data = pdfBytes instanceof Uint8Array
    ? new Uint8Array(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength))
    : new Uint8Array(pdfBytes);
  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    sizes.push({ width: viewport.width, height: viewport.height });
  }
  await doc.destroy();
  return sizes;
}

function defaultFieldSize(type) {
  if (type === 'signature') return { width: DEFAULT_SIGNATURE_WIDTH, height: DEFAULT_SIGNATURE_HEIGHT };
  if (type === 'initials') return { width: DEFAULT_INITIALS_WIDTH, height: DEFAULT_INITIALS_HEIGHT };
  return { width: DEFAULT_TEXT_WIDTH, height: DEFAULT_TEXT_HEIGHT };
}

function normalizedFieldBox(field) {
  const defaults = defaultFieldSize(field && field.type);
  const width = Math.max(1, finiteNumber(field && field.width, defaults.width));
  const height = Math.max(1, finiteNumber(field && field.height, defaults.height));
  return {
    ...field,
    page: Math.max(0, Math.trunc(finiteNumber(field && field.page, 0))),
    x: finiteNumber(field && field.x, 0),
    y: finiteNumber(field && field.y, 0),
    width,
    height,
    fontSize: Math.max(1, finiteNumber(field && field.fontSize, 11)),
  };
}

function imageFitDimensions(image, field) {
  const box = normalizedFieldBox({ ...field, type: 'signature' });
  const imageWidth = finiteNumber(image && image.width, 0);
  const imageHeight = finiteNumber(image && image.height, 0);
  const factor = imageWidth > 0 && imageHeight > 0
    ? Math.min(box.width / imageWidth, box.height / imageHeight)
    : 1;
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const dims = image.scale(safeFactor);
  return {
    width: finiteNumber(dims.width, box.width),
    height: finiteNumber(dims.height, box.height),
  };
}

module.exports = {
  getPdfPageSizes,
  normalizedFieldBox,
  imageFitDimensions,
};
