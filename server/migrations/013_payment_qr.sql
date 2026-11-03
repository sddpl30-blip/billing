-- Migration 013: the association's UPI ID and payment QR code, for the
-- proforma invoice.
--
-- The QR is the bank's static BHIM-UPI code (it carries no amount). It is
-- kept with the society's profile, as an image the office uploads, so it can
-- be changed without a release. The image is a JPEG of at most 400 KB; the
-- application checks that it is a real JPEG, roughly square and sharp enough
-- to print at 3 cm.

BEGIN;

ALTER TABLE societies
  ADD COLUMN pay_upi_id  TEXT CHECK (pay_upi_id IS NULL OR pay_upi_id ~ '^[A-Za-z0-9._-]{2,80}@[A-Za-z0-9.-]{2,40}$'),
  ADD COLUMN pay_qr_jpeg BYTEA CHECK (pay_qr_jpeg IS NULL OR octet_length(pay_qr_jpeg) <= 400000);

COMMENT ON COLUMN societies.pay_upi_id IS
  'The UPI ID members pay to, printed under the QR code on proforma invoices.';
COMMENT ON COLUMN societies.pay_qr_jpeg IS
  'The static payment QR code as a JPEG, printed on proforma invoices. Uploaded by the office in the society profile.';

COMMIT;
