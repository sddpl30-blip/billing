#!/usr/bin/env node
/**
 * The PDF writer, the money formatter and the SMTP message builder.
 *
 * All pure: no database, no network, no server. These are the parts where a
 * mistake produces a file or a message that looks fine and is not — a PDF with
 * a wrong cross-reference offset opens in one reader and fails in another, and
 * an unescaped line in a mail body truncates the message at that point.
 *
 *   node server/documents.test.mjs
 */

const build = '../.server-build/server/src';
const { buildPdf, PdfPage, money, textWidth, A4 } = await import(`${build}/pdf.js`);
const { renderInvoice, renderReceipt } = await import(`${build}/documents.js`);
const { composeMessage, quotedPrintable, dotStuff, smtpSettingsFromEnv, SmtpError } =
  await import(`${build}/providers/smtp.js`);

let passed = 0;
const failures = [];
let suiteName = '';
const suite = (n) => { suiteName = n; console.log(`\n${n}`); };

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${suiteName} / ${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
function equal(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function truthy(value, what) {
  if (!value) throw new Error(`${what}: expected something truthy, got ${JSON.stringify(value)}`);
}
function matches(text, pattern, what) {
  if (!pattern.test(String(text))) {
    throw new Error(`${what}: ${JSON.stringify(String(text).slice(0, 200))} does not match ${pattern}`);
  }
}

/**
 * Reads a PDF's cross-reference table and checks every offset.
 *
 * This is the check that matters. A reader finds an object by seeking to the
 * byte offset in this table; if the offsets are computed from string lengths
 * rather than byte lengths, they are correct until the first non-ASCII
 * character and then quietly wrong.
 */
function verifyXref(pdf) {
  const text = pdf.toString('latin1');
  const startIndex = text.lastIndexOf('startxref');
  if (startIndex < 0) throw new Error('no startxref');
  const xrefOffset = Number(text.slice(startIndex + 9).trim().split(/\s/)[0]);
  if (!Number.isInteger(xrefOffset) || xrefOffset <= 0) {
    throw new Error(`startxref is not an offset: ${xrefOffset}`);
  }
  if (text.slice(xrefOffset, xrefOffset + 4) !== 'xref') {
    throw new Error(`startxref points at ${JSON.stringify(text.slice(xrefOffset, xrefOffset + 12))}`);
  }

  const header = text.slice(xrefOffset).split('\n');
  const [, count] = header[1].trim().split(' ').map(Number);
  const entries = [];
  for (let i = 0; i < count - 1; i++) {
    const line = header[3 + i];
    entries.push(Number(line.slice(0, 10)));
  }

  for (const [index, offset] of entries.entries()) {
    const expected = `${index + 1} 0 obj`;
    const found = text.slice(offset, offset + expected.length);
    if (found !== expected) {
      throw new Error(
        `object ${index + 1}: offset ${offset} points at ${JSON.stringify(found)}, ` +
        `expected ${JSON.stringify(expected)}`,
      );
    }
  }
  return { objects: entries.length, xrefOffset };
}

// --- the writer -------------------------------------------------------------

suite('the PDF writer');

check('a one-page file is structurally sound', () => {
  const page = new PdfPage(A4);
  page.text('Hello', { size: 12 });
  const pdf = buildPdf([page], { title: 'Test', author: 'Nobody' });

  matches(pdf.subarray(0, 8).toString('latin1'), /^%PDF-1\.4/, 'header');
  matches(pdf.subarray(-6).toString('latin1'), /%%EOF/, 'trailer');
  const { objects } = verifyXref(pdf);
  // catalog, pages, three fonts, one content stream, one page, info
  equal(objects, 8, 'objects in the file');
});

check('every xref offset survives a non-ASCII byte in the content', () => {
  const page = new PdfPage(A4);
  // The binary comment after the header already puts high bytes in the file;
  // this adds more, in a place that shifts every later object.
  page.text('Rupee ₹ and a dash — and a quote ’', { size: 11 });
  const pdf = buildPdf([page], { title: 'Non äscii', author: 'Someone — else' });
  verifyXref(pdf);
  const text = pdf.toString('latin1');
  // The rupee sign is not in WinAnsiEncoding, so it is written as INR rather
  // than as a byte that would render as something else.
  matches(text, /INR  and a dash - and a quote '/, 'the substituted text');
});

check('a parenthesis in text cannot break out of the string', () => {
  const page = new PdfPage(A4);
  page.text('Flat A-101 (owner) \\ backslash', { size: 10 });
  const pdf = buildPdf([page], { title: 'Escapes', author: 'Test' });
  verifyXref(pdf);
  const text = pdf.toString('latin1');
  matches(text, /\(Flat A-101 \\\(owner\\\) \\\\ backslash\)/, 'the escaped literal');
});

check('two pages produce two page objects', () => {
  const first = new PdfPage(A4);
  first.text('One');
  const second = new PdfPage(A4);
  second.text('Two');
  const pdf = buildPdf([first, second], { title: 'Two', author: 'Test' });
  const { objects } = verifyXref(pdf);
  equal(objects, 10, 'objects');
  equal((pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length, 2, 'page objects');
  matches(pdf.toString('latin1'), /\/Count 2/, 'the page count');
});

check('a content stream declares its own length in bytes', () => {
  const page = new PdfPage(A4);
  page.text('A dash — here', { size: 10 });
  const pdf = buildPdf([page], { title: 'Length', author: 'Test' });
  const text = pdf.toString('latin1');
  const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
  truthy(match, 'a stream with a length');
  equal(Buffer.byteLength(match[2], 'latin1'), Number(match[1]), 'declared against actual');
});

check('a page with no content still produces a valid file', () => {
  const pdf = buildPdf([new PdfPage(A4)], { title: 'Empty', author: 'Test' });
  verifyXref(pdf);
});

check('a file with no pages is refused', () => {
  try {
    buildPdf([], { title: 'None', author: 'Test' });
    throw new Error('it was accepted');
  } catch (err) {
    matches(err.message, /at least one page/, 'the refusal');
  }
});

// --- money ------------------------------------------------------------------

suite('money formatting');

check('paise become rupees with two decimals', () => {
  equal(money(0), '0.00', 'zero');
  equal(money(1), '0.01', 'one paisa');
  equal(money(100), '1.00', 'one rupee');
  equal(money(12345), '123.45', 'a hundred and twenty three rupees');
});

check('thousands are grouped the Indian way', () => {
  // Last three digits, then pairs: 1,00,000 rather than 100,000.
  equal(money(10_000_000), '1,00,000.00', 'one lakh');
  equal(money(100_000_000), '10,00,000.00', 'ten lakh');
  equal(money(1_000_000_000), '1,00,00,000.00', 'one crore');
  equal(money(48_757_5), '4,875.75', 'four thousand odd');
});

check('a negative figure keeps its sign in front of the grouping', () => {
  equal(money(-10_000_000), '-1,00,000.00', 'a lakh out');
  equal(money(-1), '-0.01', 'one paisa out');
});

check('text width is proportional and monospace is exact', () => {
  truthy(textWidth('iii', 10) < textWidth('WWW', 10), 'i is narrower than W');
  equal(textWidth('abcd', 10, 'mono'), 24, 'four Courier characters at 10pt');
  truthy(textWidth('Total', 10, 'bold') > textWidth('Total', 10), 'bold is wider');
});

// --- the documents ----------------------------------------------------------

suite('rendered documents');

const society = {
  name: 'Test Residents Association',
  registrationNo: null,
  gstin: null,
  stateCode: null,
  mode: 'production',
};

const invoice = {
  kind: 'tax-invoice',
  society,
  documentNo: 'MV/2026/00007',
  proformaNo: 'PI/2026-07/0007',
  period: 'Jul 2026',
  issuedOn: '2026-07-01',
  dueOn: '2026-07-16',
  flatNo: 'B-204',
  ownerName: 'A Member',
  lines: [
    { head: 'maintenance', label: 'Maintenance charges', amount: 443_250, taxable: true },
    { head: 'sinking', label: 'Sinking fund contribution', amount: 44_325, taxable: false },
  ],
  taxableValue: 443_250,
  cgst: 39_892,
  sgst: 39_893,
  ratePercent: 18,
  net: 487_575,
  gross: 567_360,
  outstanding: 567_360,
  state: 'tax-invoice',
};

check('a tax invoice carries its figures', () => {
  const pdf = renderInvoice(invoice);
  verifyXref(pdf);
  const text = pdf.toString('latin1');
  matches(text, /TAX INVOICE/, 'the title');
  matches(text, /MV\/2026\/00007/, 'the invoice number');
  matches(text, /4,432\.50/, 'the maintenance figure');
  matches(text, /398\.92/, 'the CGST figure');
  matches(text, /5,673\.60/, 'the total');
  matches(text, /Flat B-204/, 'the flat');
  matches(text, /A Member/, 'the owner');
});

check('a society with no GSTIN says so rather than printing one', () => {
  const text = renderInvoice(invoice).toString('latin1');
  matches(text, /No registration or GSTIN on record/, 'the statement');
  truthy(!/GSTIN [0-9]/.test(text), 'no invented number');
});

check('a society with one prints it', () => {
  const text = renderInvoice({
    ...invoice,
    society: { ...society, gstin: '27AAAAA0000A1Z5', registrationNo: 'PNE/1234/2008' },
  }).toString('latin1');
  matches(text, /GSTIN 27AAAAA0000A1Z5/, 'the GSTIN');
  matches(text, /Regn\. PNE\/1234\/2008/, 'the registration');
});

check('a proforma says it is not a tax invoice', () => {
  const text = renderInvoice({ ...invoice, kind: 'proforma', cgst: 0, sgst: 0 })
    .toString('latin1');
  matches(text, /PROFORMA INVOICE/, 'the title');
  matches(text, /not a tax invoice/, 'the statement');
  matches(text, /No GST charged on this document/, 'the tax line');
});

check('demonstration data is marked on the face of the document', () => {
  const text = renderInvoice({ ...invoice, society: { ...society, mode: 'demo' } })
    .toString('latin1');
  matches(text, /DEMONSTRATION DATA - NOT A VALID DOCUMENT/, 'the header mark');
  matches(text, /Not a valid tax invoice/, 'the footer');
});

check('a settled invoice says so instead of showing a figure', () => {
  const text = renderInvoice({ ...invoice, outstanding: 0 }).toString('latin1');
  matches(text, /Settled in full/, 'the statement');
});

check('a receipt carries its allocations and any advance', () => {
  const pdf = renderReceipt({
    society,
    receiptNo: 'RC/2026-07/0003',
    receivedOn: '2026-07-22',
    flatNo: 'B-204',
    ownerName: 'A Member',
    amount: 600_000,
    method: 'upi',
    instrumentRef: 'UPI123456',
    allocations: [
      { taxInvoiceNo: 'MV/2026/00007', amount: 567_360 },
      { taxInvoiceNo: null, amount: 32_640 },
    ],
    heldAsAdvance: 32_640,
  });
  verifyXref(pdf);
  const text = pdf.toString('latin1');
  matches(text, /RECEIPT/, 'the title');
  matches(text, /RC\/2026-07\/0003/, 'the receipt number');
  matches(text, /INR 6,000\.00/, 'the amount');
  matches(text, /MV\/2026\/00007/, 'the invoice it settled');
  matches(text, /Held on account/, 'the advance line');
  matches(text, /326\.40 is held as an advance/, 'the advance explained');
  matches(text, /UPI123456/, 'the instrument reference');
});

// --- SMTP -------------------------------------------------------------------

suite('SMTP message building');

check('a plain message has the headers a mail server needs', () => {
  const text = composeMessage(
    { to: 'member@example.invalid', subject: 'Your bill', text: 'Due on the 16th.' },
    { from: 'books@example.invalid', fromName: 'The Association', messageId: 'abc@example.invalid' },
  );
  matches(text, /^From: The Association <books@example\.invalid>/m, 'from');
  matches(text, /^To: member@example\.invalid$/m, 'to');
  matches(text, /^Subject: Your bill$/m, 'subject');
  matches(text, /^Message-ID: <abc@example\.invalid>$/m, 'message id');
  matches(text, /^MIME-Version: 1\.0$/m, 'mime version');
  matches(text, /^Content-Transfer-Encoding: quoted-printable$/m, 'encoding');
  matches(text, /\r\n\r\nDue on the 16th\./, 'the body after a blank line');
});

check('headers use CRLF, as the protocol requires', () => {
  const text = composeMessage(
    { to: 'a@b.invalid', subject: 'x', text: 'y' },
    { from: 'c@d.invalid', messageId: 'm@d.invalid' },
  );
  truthy(!/[^\r]\n/.test(text.split('\r\n\r\n')[0]), 'no bare newline in the headers');
});

check('a non-ASCII subject is encoded rather than sent raw', () => {
  const text = composeMessage(
    { to: 'a@b.invalid', subject: 'Facturación — julio', text: 'x' },
    { from: 'c@d.invalid', messageId: 'm@d.invalid' },
  );
  matches(text, /^Subject: =\?UTF-8\?B\?/m, 'an encoded word');
  truthy(!/Facturación/.test(text), 'the raw 8-bit text is not in the headers');
});

check('an attachment makes it multipart, with base64 in short lines', () => {
  const body = Buffer.from('%PDF-1.4 pretend'.repeat(20), 'latin1');
  const text = composeMessage(
    {
      to: 'a@b.invalid', subject: 'Invoice', text: 'Attached.',
      attachments: [{ filename: 'inv.pdf', contentType: 'application/pdf', body }],
    },
    { from: 'c@d.invalid', messageId: 'm@d.invalid' },
  );
  matches(text, /Content-Type: multipart\/mixed; boundary="sb-/, 'the multipart header');
  matches(text, /Content-Disposition: attachment; filename="inv\.pdf"/, 'the disposition');
  matches(text, /Content-Transfer-Encoding: base64/, 'the encoding');
  const base64Lines = text.split('\r\n').filter(line => /^[A-Za-z0-9+/=]{20,}$/.test(line));
  truthy(base64Lines.length > 1, 'the attachment is wrapped over several lines');
  for (const line of base64Lines) truthy(line.length <= 76, `line of ${line.length} characters`);
  // The boundary ends the message, or a reader keeps looking for more parts.
  matches(text, /--sb-[^\r\n]+--\r\n$/, 'the closing boundary');
});

check('quoted-printable escapes what it must and nothing else', () => {
  equal(quotedPrintable('plain text'), 'plain text', 'ASCII is untouched');
  equal(quotedPrintable('a=b'), 'a=3Db', 'an equals sign');
  equal(quotedPrintable('café'), 'caf=C3=A9', 'a two-byte character');
  // Trailing whitespace is stripped in transit unless it is encoded.
  equal(quotedPrintable('trailing '), 'trailing=20', 'a trailing space');
});

check('a long line is folded with a soft break', () => {
  const folded = quotedPrintable('x'.repeat(200));
  const lines = folded.split('\r\n');
  for (const line of lines) truthy(line.length <= 76, `line of ${line.length}`);
  for (const line of lines.slice(0, -1)) matches(line, /=$/, 'a soft break at the end');
  equal(folded.replace(/=\r\n/g, ''), 'x'.repeat(200), 'the text survives unfolding');
});

check('a soft break never splits an escape sequence', () => {
  // A line of two-byte characters, so the 75-character cut lands inside one.
  const folded = quotedPrintable('é'.repeat(40));
  for (const line of folded.split('\r\n')) {
    truthy(!/=[0-9A-F]?$/.test(line.replace(/=$/, '')), `a split escape in ${line.slice(-6)}`);
  }
  equal(folded.replace(/=\r\n/g, '').replace(/=C3=A9/g, 'x'), 'x'.repeat(40), 'it unfolds');
});

check('a line that is only a dot is stuffed, or the message is truncated there', () => {
  equal(dotStuff('before\n.\nafter'), 'before\r\n..\r\nafter', 'the lone dot');
  equal(dotStuff('.hidden'), '..hidden', 'a leading dot');
  equal(dotStuff('no dots here'), 'no dots here', 'nothing to do');
});

suite('SMTP configuration');

check('no host means no provider, rather than a broken one', () => {
  equal(smtpSettingsFromEnv({}), null, 'with nothing set');
  equal(smtpSettingsFromEnv({ SMTP_HOST: '   ' }), null, 'with a blank host');
});

check('a host with no sender is refused', () => {
  try {
    smtpSettingsFromEnv({ SMTP_HOST: 'mail.example.invalid' });
    throw new Error('it was accepted');
  } catch (err) {
    truthy(err instanceof SmtpError, 'an SmtpError');
    matches(err.message, /SMTP_FROM/, 'which names what is missing');
  }
});

check('TLS is required unless it is turned off deliberately', () => {
  const settings = smtpSettingsFromEnv({
    SMTP_HOST: 'mail.example.invalid', SMTP_FROM: 'books@example.invalid',
  });
  equal(settings.requireTls, true, 'by default');
  equal(settings.port, 587, 'the submission port');
  equal(settings.implicitTls, false, 'STARTTLS rather than implicit');

  const relaxed = smtpSettingsFromEnv({
    SMTP_HOST: 'localhost', SMTP_FROM: 'books@example.invalid', SMTP_REQUIRE_TLS: 'false',
  });
  equal(relaxed.requireTls, false, 'when turned off');
});

check('port 465 is implicit TLS without being told', () => {
  const settings = smtpSettingsFromEnv({
    SMTP_HOST: 'mail.example.invalid', SMTP_FROM: 'b@e.invalid', SMTP_PORT: '465',
  });
  equal(settings.implicitTls, true, 'implicitTls');
});

check('a port that is not a port is refused', () => {
  try {
    smtpSettingsFromEnv({
      SMTP_HOST: 'mail.example.invalid', SMTP_FROM: 'b@e.invalid', SMTP_PORT: 'smtp',
    });
    throw new Error('it was accepted');
  } catch (err) {
    matches(err.message, /must be a port number/, 'the refusal');
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
