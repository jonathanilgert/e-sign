/**
 * Modify the residential tenancy agreement template:
 * 1. Remove page 12 (accommodation inspection report)
 * 2. Simplify page 9 signature area (remove witness lines)
 * 3. Simplify date fields throughout (single date instead of day/month/year)
 * 4. Clean up page 11 acknowledgment date
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

async function main() {
  const inputPath = path.join(__dirname, 'templates', 'residential-tenancy-agreement.pdf');
  const buf = fs.readFileSync(inputPath);
  const doc = await PDFDocument.load(buf);
  const font = await doc.embedFont(StandardFonts.CourierBold);
  const fontRegular = await doc.embedFont(StandardFonts.Courier);
  const white = rgb(1, 1, 1);
  const black = rgb(0, 0, 0);
  const darkBlue = rgb(0.1, 0.1, 0.3);

  // Helper: draw white rectangle to cover old text
  function whiteOut(page, x, y, w, h) {
    page.drawRectangle({ x, y, width: w, height: h, color: white, borderWidth: 0 });
  }

  // ============================================================
  // 1. Remove page 12 (Accommodation Inspection Report) - index 11
  // ============================================================
  doc.removePage(11);
  console.log('Removed page 12 (inspection report)');

  // ============================================================
  // 2. Fix page 1: Simplify "THE ___ DAY OF ___, 20__" to single date
  // ============================================================
  const page1 = doc.getPage(0);

  // Cover "THE ___ DAY OF ___, 20__." on page 1 (y=666 to y=680 area)
  whiteOut(page1, 340, 664, 210, 20);  // Cover "THE DAY OF"
  whiteOut(page1, 70, 664, 230, 16);   // Cover ", 20 ."

  // Write replacement text
  page1.drawText('dated:', { x: 346, y: 669, size: 10, font: fontRegular, color: black });
  page1.drawText('[Date to be entered digitally]', { x: 382, y: 669, size: 8, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });

  // Fix term commencement date: "commencing at 12:00 o'clock noon on the ___ day of ___, 20__"
  // y=109: "day of ___, 20__"
  whiteOut(page1, 70, 105, 270, 16);   // Cover "day of    , 20"
  page1.drawText('[Commencement date]', { x: 72, y: 109, size: 8, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });

  // Fix term end date: "the ___ day of ___, 20__"
  // y=95: "the ___ day of ___, 20__"
  whiteOut(page1, 70, 91, 310, 16);    // Cover end date line
  page1.drawText('[End date]', { x: 72, y: 95, size: 8, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });

  console.log('Simplified date fields on page 1');

  // ============================================================
  // 3. Rewrite page 9: Remove witness sections, simplify signatures
  // ============================================================
  const page9 = doc.getPage(8);

  // White out the entire witness/signature area (y=438 to y=700)
  whiteOut(page9, 60, 430, 490, 280);

  // Write clean signature section
  let y = 696;
  const leftX = 72;

  page9.drawText('IN WITNESS WHEREOF', { x: leftX, y, size: 11, font: font, color: black });
  y -= 16;
  page9.drawText('The parties hereto have executed this Agreement digitally.', { x: leftX, y, size: 10, font: fontRegular, color: black });

  y -= 35;
  page9.drawText('LANDLORD', { x: leftX, y, size: 10, font: font, color: darkBlue });
  y -= 18;
  page9.drawText('Name: ________________________________________', { x: leftX, y, size: 10, font: fontRegular, color: black });
  y -= 18;
  page9.drawText('Signature: ____________________________________', { x: leftX, y, size: 10, font: fontRegular, color: black });
  y -= 18;
  page9.drawText('Date: _________________________________________', { x: leftX, y, size: 10, font: fontRegular, color: black });

  y -= 35;
  page9.drawText('TENANT', { x: leftX, y, size: 10, font: font, color: darkBlue });
  y -= 18;
  page9.drawText('Name: ________________________________________', { x: leftX, y, size: 10, font: fontRegular, color: black });
  y -= 18;
  page9.drawText('Signature: ____________________________________', { x: leftX, y, size: 10, font: fontRegular, color: black });
  y -= 18;
  page9.drawText('Date: _________________________________________', { x: leftX, y, size: 10, font: fontRegular, color: black });

  y -= 30;
  page9.drawText('Both parties attest that this digitally signed document is legally', { x: leftX, y, size: 8, font: fontRegular, color: rgb(0.4, 0.4, 0.4) });
  y -= 12;
  page9.drawText('binding and enforceable as if signed in person.', { x: leftX, y, size: 8, font: fontRegular, color: rgb(0.4, 0.4, 0.4) });

  // Also white out the "RECEIPT OF RENTAL AGREEMENT" date section
  // (I, ___, (the Tenant) HEREBY ACKNOWLEDGE... THIS ___ DAY OF ___, 20__.)
  whiteOut(page9, 60, 370, 490, 68);

  // Rewrite as simplified
  y = 430;
  page9.drawText('RECEIPT OF RENTAL AGREEMENT', { x: leftX, y, size: 10, font: font, color: black });
  y -= 18;
  page9.drawText('The Tenant hereby acknowledges receipt of a copy of this Agreement.', { x: leftX, y, size: 10, font: fontRegular, color: black });
  y -= 15;
  page9.drawText('Date: _________________________________________', { x: leftX, y, size: 10, font: fontRegular, color: black });

  console.log('Simplified signature section on page 9');

  // ============================================================
  // 4. Fix page 11: Simplify "this ___ day of ___, 20__."
  // ============================================================
  const page11 = doc.getPage(10); // now index 10 since page 12 was removed

  // Cover the date line: "this ___ day of ___, 20__."
  whiteOut(page11, 125, 529, 260, 16);
  page11.drawText('Date: ___________________', { x: 155, y: 533, size: 10, font: fontRegular, color: black });

  console.log('Simplified date on page 11');

  // ============================================================
  // Save
  // ============================================================
  const outputPath = path.join(__dirname, 'templates', 'residential-tenancy-agreement.pdf');
  const newBytes = await doc.save();
  fs.writeFileSync(outputPath, newBytes);

  // Also update the copy in uploads if it exists
  const uploadsDir = path.join(__dirname, 'uploads');
  const copies = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.pdf'));
  copies.forEach(f => {
    fs.writeFileSync(path.join(uploadsDir, f), newBytes);
  });

  console.log(`\nSaved modified template (${doc.getPageCount()} pages)`);
}

main().catch(e => { console.error(e); process.exit(1); });
