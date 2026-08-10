const { rgb } = require('pdf-lib');

function normalizePdfText(text, font) {
  // pdf-lib StandardFonts use WinAnsi: raw newlines/control chars (and some
  // pasted Unicode like emoji) throw during width calculation or drawText.
  // Signing field values should render as printable text, not crash send.
  const flattened = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  let safe = '';
  for (const ch of flattened) {
    try {
      font.encodeText(ch);
      safe += ch;
    } catch (e) {
      safe += '?';
    }
  }
  return safe;
}

// Draw text within field bounds: tries single line first, wraps if needed, shrinks as last resort.
function drawFieldText(page, font, text, field) {
  text = normalizePdfText(text, font);
  if (!text) return;

  const maxSize = field.fontSize || 11;
  const padding = 3;
  const fieldW = field.width - padding * 2;
  const fieldH = field.height || 18;
  const lineSpacing = 1.25;

  // Try single line at full size first.
  let size = maxSize;
  let textWidth = font.widthOfTextAtSize(text, size);
  if (textWidth <= fieldW) {
    page.drawText(text, {
      x: field.x + padding, y: field.y + 4,
      size, font, color: rgb(0, 0, 0.4)
    });
    return;
  }

  // Wrap text into multiple lines.
  const words = text.split(/\s+/);
  let lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    if (font.widthOfTextAtSize(testLine, size) <= fieldW) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      // If a single word is too wide, shrink font for it.
      if (font.widthOfTextAtSize(word, size) > fieldW) {
        let wordSize = size;
        while (wordSize > 6 && font.widthOfTextAtSize(word, wordSize) > fieldW) {
          wordSize -= 0.5;
        }
        size = wordSize;
      }
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Check if wrapped lines fit vertically; if not, shrink font.
  while (lines.length * size * lineSpacing > fieldH && size > 6) {
    size -= 0.5;
    lines = [];
    currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      if (font.widthOfTextAtSize(testLine, size) <= fieldW) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  // Draw each line, starting from top of field (highest y in PDF coords).
  const startY = field.y + fieldH - size - 2;
  for (let i = 0; i < lines.length; i++) {
    const lineY = startY - (i * size * lineSpacing);
    if (lineY < field.y - 2) break;
    page.drawText(lines[i], {
      x: field.x + padding, y: lineY,
      size, font, color: rgb(0, 0, 0.4)
    });
  }
}

module.exports = { normalizePdfText, drawFieldText };
