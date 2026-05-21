const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getPdfPageSizes,
  normalizedFieldBox,
  imageFitDimensions,
} = require('../lib/pdf-signing');

test('getPdfPageSizes reads encrypted library PDFs for signing overlays', async () => {
  const encryptedPaths = [
    'library/real-estate/ontario-residential-tenancy-2229E.pdf',
    'library/vehicles/bc-icbc-apv9t-transfer-tax.pdf',
  ];

  for (const rel of encryptedPaths) {
    const bytes = fs.readFileSync(path.join(__dirname, '..', rel));
    const sizes = await getPdfPageSizes(bytes);
    assert.ok(sizes.length > 0, `${rel} should report pages`);
    assert.ok(sizes.every(size => size.width > 0 && size.height > 0), `${rel} should report usable page sizes`);
  }
});

test('normalizedFieldBox supplies safe dimensions when client fields omit width or height', () => {
  const field = normalizedFieldBox({ id: 'sig1', type: 'signature', page: 0, x: 12, y: 34 });

  assert.equal(field.width, 240);
  assert.equal(field.height, 50);
  assert.equal(field.x, 12);
  assert.equal(field.y, 34);
});

test('imageFitDimensions never returns NaN for malformed signature field dimensions', () => {
  const dims = imageFitDimensions(
    { width: 600, height: 200, scale: factor => ({ width: 600 * factor, height: 200 * factor }) },
    { width: undefined, height: Number.NaN }
  );

  assert.ok(Number.isFinite(dims.width));
  assert.ok(Number.isFinite(dims.height));
  assert.equal(dims.width, 150);
  assert.equal(dims.height, 50);
});
