/**
 * The four public pages a payment gateway asks for: terms, refund and
 * cancellation, privacy, contact. The wording is the Association's own text.
 * They open without signing in, at /terms, /refund-policy, /privacy and
 * /contact, and are linked from the sign-in screen and every page's footer.
 *
 * The contact details here must read exactly as the bank account's records do.
 * The phone number is not yet known: it prints as a placeholder until set.
 */

export const ASSOCIATION = 'Mani Vista Residents Association';
export const ADDRESS = 'Mani Vista Complex, Block A, New Town, Kolkata, West Bengal - 700156';
export const EMAIL = 'mvra2026@gmail.com';
/** Set when the Association supplies it. Null prints a visible placeholder. */
export const PHONE: string | null = null;
export const PHONE_TEXT = PHONE ?? '+91 [to be updated]';
export const UPDATED = '24 November 2026';

export type PolicyKey = 'terms' | 'refund-policy' | 'privacy' | 'contact';

export interface Block { readonly heading?: string; readonly text?: string; readonly list?: readonly string[] }

export interface PolicyPage {
  readonly key: PolicyKey;
  readonly path: string;
  readonly navLabel: string;
  readonly title: string;
  readonly updated: string | null;
  readonly blocks: readonly Block[];
}

export const POLICY_PAGES: readonly PolicyPage[] = [
  {
    key: 'terms', path: '/terms', navLabel: 'Terms and Conditions', title: 'Terms and Conditions', updated: UPDATED,
    blocks: [
      { text: `These Terms govern use of the MVRA resident portal operated by ${ASSOCIATION} ("MVRA", "we"). By using the portal or paying online you agree to them.` },
      { heading: '1. Who can use the portal', text: 'Owners and authorised residents of Mani Vista whose details are registered with MVRA. Keep your sign-in details private and tell us promptly of any misuse.' },
      { heading: '2. What you can pay', text: 'Maintenance and other charges billed by MVRA through proforma invoices, tax invoices and receipts issued on the portal, including any arrears shown on your bill.' },
      { heading: '3. Amounts and invoices', text: 'Amounts follow the rates approved by the Association. A proforma invoice is a request for payment. A GST tax invoice, where applicable, is issued after payment. If you see a mistake, write to us before paying; corrections are made by the Association with an audit record.' },
      { heading: '4. Online payment', text: "Payments are processed by ICICI Bank's payment gateway. MVRA does not see or store your card, UPI or net-banking credentials. A payment is complete only when the gateway confirms success and a receipt is issued on the portal. Any gateway or bank charges are shown before you pay." },
      { heading: '5. Receipts', text: 'A receipt is e-mailed to your registered address and is available on the portal. Keep it as proof of payment.' },
      { heading: '6. Failed or pending payments', text: 'If money is debited but no receipt is issued, do not pay again. Wait 24 hours, then contact us with the transaction reference. See the Refund and Cancellation Policy.' },
      { heading: '7. Late payment', text: "Late fees or interest apply only as per the Association's approved bye-laws or resolutions and are shown on your bill." },
      { heading: '8. Your details', text: 'Keep your e-mail, phone and GSTIN (if needed) up to date. Change requests are handled by the Secretary.' },
      { heading: '9. Acceptable use', text: "Do not attempt to access other residents' data, disrupt the service or use it for anything unlawful." },
      { heading: '10. Availability and liability', text: 'We try to keep the portal available but do not guarantee uninterrupted service. To the extent the law allows, MVRA is not liable for delays or failures caused by banks, the payment gateway, your internet or device, or events outside our control.' },
      { heading: '11. Changes, law and disputes', text: 'We may update these Terms; the date above shows the latest version. Indian law applies. Disputes are subject to the courts at Kolkata, after first being raised with the Association.' },
    ],
  },
  {
    key: 'refund-policy', path: '/refund-policy', navLabel: 'Refund and Cancellation', title: 'Refund and Cancellation Policy', updated: UPDATED,
    blocks: [
      { heading: 'Cancellation', text: 'Maintenance and other charges billed by MVRA are dues of the Association and cannot be cancelled once the invoice is issued. For hall or amenity bookings: full refund if cancelled 7 or more days before the event; 50% if cancelled 3 to 6 days before; no refund if less than 3 days. The Committee may change these terms.' },
      { heading: 'When we refund', list: [
        'Duplicate payment for the same invoice.',
        'Excess amount paid over the invoice amount.',
        'Payment debited but not credited to MVRA (failed transaction).',
        'Booking cancelled within the terms above.',
        "Amount paid in error, with the Committee's approval.",
      ] },
      { heading: 'When we do not refund', text: 'Dues that were correctly billed and paid. For excess payments we will first offer to adjust the amount against your next bill.' },
      { heading: 'How to request', text: `E-mail ${EMAIL} with your flat number, invoice or receipt number, transaction reference, amount and date.` },
      { heading: 'Approval', text: 'A refund needs two Committee members, one to request and another to approve, and is recorded on the books with an audit trail.' },
      { heading: 'Timeline and mode', text: 'Approved refunds are returned to the original payment source within 7 to 10 working days of approval. Failed transactions debited by the bank are usually reversed automatically by the bank within 5 to 7 working days. Your bank may take extra time to show the credit.' },
      { heading: 'Gateway charges', text: 'Charges levied by the gateway or bank on a successful payment are non-refundable, except where the refund is due to our error.' },
    ],
  },
  {
    key: 'privacy', path: '/privacy', navLabel: 'Privacy Policy', title: 'Privacy Policy', updated: UPDATED,
    blocks: [
      { text: 'MVRA respects your privacy. This policy explains what we collect, why, and your choices, in line with the Information Technology Act, 2000 and the Digital Personal Data Protection Act, 2023.' },
      { heading: 'What we collect', text: 'Owner name, flat number, billing area, e-mail address(es), mobile number, GSTIN where you give it, payment and receipt history, and portal sign-in activity.' },
      { heading: 'What we do not store', text: 'Card numbers, CVV, UPI PIN and net-banking passwords. These are entered only on the ICICI Bank payment gateway page.' },
      { heading: 'Why we use it', text: 'To raise bills and receipts, collect payments, send notices and statements, issue GST invoices, meet accounting and legal obligations, and run the Association.' },
      { heading: 'Who we share it with', text: "Only the providers needed to run the portal: ICICI Bank and its payment gateway, our e-mail delivery provider, and our hosting and database providers. We do not sell your data or use it for advertising. We disclose it when the law or a court requires." },
      { heading: 'How long we keep it', text: 'While you are an owner or resident, and afterwards for the period accounting and tax law require.' },
      { heading: 'Security', text: 'Access is role-based, sensitive actions need a second approver, and changes are logged. Please protect your sign-in details.' },
      { heading: 'Your rights', text: 'You can ask to see, correct or update your details, withdraw consent for non-essential communication, or raise a complaint. Some records must be kept by law.' },
      { heading: 'Cookies and e-mail', text: 'The portal uses only the cookies needed to keep you signed in. We send bills, receipts and notices to your registered address(es).' },
      { heading: 'Grievance contact', text: `The Secretary, ${ASSOCIATION}, ${EMAIL}. We aim to reply within 7 working days.` },
    ],
  },
  {
    key: 'contact', path: '/contact', navLabel: 'Contact', title: 'Contact Us', updated: null,
    blocks: [
      { text: `${ASSOCIATION}\n${ADDRESS}` },
      { text: `E-mail: ${EMAIL}\nPhone: ${PHONE_TEXT}` },
      { text: 'Write to us for billing queries, payment issues and refund requests. Please include your flat number and transaction reference.' },
    ],
  },
];

/** The policy page a URL path names, or null for anything else (the app itself). */
export function policyForPath(pathname: string, base = '/'): PolicyPage | null {
  let path = pathname;
  if (base !== '/' && path.startsWith(base)) path = `/${path.slice(base.length)}`;
  path = path.replace(/\/+$/, '') || '/';
  return POLICY_PAGES.find(p => p.path === path) ?? null;
}
