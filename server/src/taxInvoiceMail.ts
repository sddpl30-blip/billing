/**
 * Sending an issued tax invoice to the owner, and recording what happened.
 *
 * The PDF is the copy kept with the invoice. It goes to every address the
 * owner has on record. An address the mail service has on its block-list is
 * left out and flagged, so the office can unblock it; if every address is
 * blocked, nothing is sent and the invoice carries the flag. Every attempt is
 * written to the dispatch history and the audit trail, with what the service
 * answered. An owner with no address is "in-app only".
 */

import { audit } from './audit';
import { ownerMailSql, recipientsOf } from './contactEmails';
import { generateDocument } from './documents';
import type { PgPool } from './pg';
import type { EmailProvider } from './providers/email';

export type MailOutcome = 'sent' | 'failed' | 'blocked' | 'in-app';

export interface MailResult { readonly outcome: MailOutcome; readonly note: string }

export async function emailTaxInvoice(
  pool: PgPool, email: EmailProvider,
  input: { societyId: string; documentId: string; userId: string | null; userLabel: string; requestId: string; today: string },
): Promise<MailResult> {
  // Read and render in one transaction; the send and its record are separate,
  // so a failed send can never undo an issued invoice.
  const prepared = await pool.transaction(async (tx) => {
    const found = await tx.query<{
      tax_invoice_no: string | null; proforma_no: string; flat_no: string; period: string; gross: string;
      state: string; recipients: string | null;
    }>(
      `SELECT d.tax_invoice_no, d.proforma_no, f.flat_no, d.period, d.gross::text, d.state,
              (SELECT ${await ownerMailSql(tx)} FROM flat_ownership fo JOIN owners o ON o.id = fo.owner_id
                WHERE fo.flat_id = d.flat_id AND fo.role = 'owner' AND fo.held_until IS NULL LIMIT 1) AS recipients
         FROM billing_documents d JOIN flats f ON f.id = d.flat_id
        WHERE d.id = $1 AND d.society_id = $2`,
      [input.documentId, input.societyId],
    );
    const doc = found.rows[0];
    if (doc === undefined || doc.state !== 'tax-invoice' || doc.tax_invoice_no === null) return null;
    const generated = await generateDocument(tx, {
      societyId: input.societyId, kind: 'tax-invoice', documentId: input.documentId, asAt: input.today, reprint: true,
    });
    return { doc, pdf: generated.pdf };
  });
  if (prepared === null) return { outcome: 'failed', note: 'That document is not an issued tax invoice.' };
  const { doc, pdf } = prepared;
  const no = doc.tax_invoice_no as string;

  let outcome: MailOutcome;
  let note: string;
  let providerId: string | null = null;
  let failure: string | null = null;
  const all = doc.recipients === null ? [] : recipientsOf(doc.recipients);

  if (all.length === 0) {
    outcome = 'in-app'; failure = 'no-recipient';
    note = 'No owner e-mail on record: in-app only. Print or download the PDF.';
  } else if (!email.delivers) {
    outcome = 'failed'; failure = 'provider-not-configured';
    note = `No e-mail service is configured (${email.name}), so nothing was sent.`;
  } else {
    let blocked: string[] = [];
    try {
      const list = email.blockedAddresses === undefined ? [] : await email.blockedAddresses();
      const set = new Set(list.map(b => b.email));
      blocked = all.filter(a => set.has(a.toLowerCase()));
    } catch { /* the check is a courtesy: a failure to read the list must not stop the send */ }
    const sendTo = all.filter(a => !blocked.includes(a));
    if (sendTo.length === 0) {
      outcome = 'blocked'; failure = `blocked by the mail service: ${blocked.join(', ')}`;
      note = `Not sent: every address is on the mail service's block-list (${blocked.join(', ')}). Unblock it on Flats & owners, then Resend.`;
    } else {
      try {
        const sent = await email.send({
          to: sendTo.join(', '),
          subject: `Tax invoice ${no} — unit ${doc.flat_no}, ${doc.period}`,
          text:
            `Dear member,\n\nPlease find attached tax invoice ${no} for unit ${doc.flat_no}, ` +
            `maintenance for ${doc.period}, issued against your payment.\n` +
            `Invoice value: INR ${(Number(doc.gross) / 100).toFixed(2)}.\n\n` +
            'Kindly quote the invoice number in any correspondence.',
          attachments: [{ filename: `${no.replace(/[^A-Za-z0-9.-]/g, '-')}.pdf`, contentType: 'application/pdf', body: pdf }],
        });
        providerId = sent.providerMessageId;
        outcome = blocked.length > 0 ? 'blocked' : 'sent';
        note = `Emailed to ${sendTo.join(', ')} via ${sent.provider}.` +
          (blocked.length > 0 ? ` NOT sent to ${blocked.join(', ')}: on the block-list. Unblock, then Resend.` : '');
        if (blocked.length > 0) failure = `blocked by the mail service: ${blocked.join(', ')}`;
      } catch (err) {
        outcome = 'failed'; failure = err instanceof Error ? err.message : 'send failed';
        note = `The mail service refused the message: ${failure}`;
      }
    }
  }

  await pool.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO dispatch_attempts (document_id, by_user, channel, delivered, provider_id, failure, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.documentId, input.userId, outcome === 'in-app' ? 'in-app' : 'email', providerId !== null, providerId, failure, note],
    );
    await audit(tx, {
      societyId: input.societyId, actorUser: input.userId, actorLabel: input.userLabel,
      action: 'tax-invoice.email', subjectTable: 'billing_documents', subjectId: input.documentId,
      detail: { taxInvoiceNo: no, outcome, failure }, requestId: input.requestId,
    });
  });
  return { outcome, note };
}
