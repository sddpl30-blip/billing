-- Migration 004: fix the receipt-allocation guard.
--
-- Migration 003 attached one trigger function to both `receipt_allocations`
-- and `payments`. It reads NEW.payment_id, which exists on the allocation row
-- but not on the payment row — where the column is `id` — so every insert into
-- `payments` failed with "record new has no field payment_id". The constraint
-- was unusable in both directions: it could not pass, so it also could not
-- catch anything.
--
-- Split into two functions over one shared check. Added as a new migration
-- rather than by editing 003, because 003 has been applied and editing an
-- applied migration is how two deployments end up on the same version number
-- with different schemas.

BEGIN;

-- The check itself, taking the payment id directly.
CREATE OR REPLACE FUNCTION assert_payment_fully_allocated(pid UUID) RETURNS VOID AS $$
DECLARE
  allocated BIGINT;
  received BIGINT;
BEGIN
  SELECT amount INTO received FROM payments WHERE id = pid;
  IF received IS NULL THEN
    RAISE EXCEPTION 'allocation references payment % which does not exist', pid;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO allocated
    FROM receipt_allocations WHERE payment_id = pid;

  IF allocated <> received THEN
    RAISE EXCEPTION
      'payment % received % paise but its allocations total % (out by %)',
      pid, received, allocated, allocated - received;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Fired from an allocation row, which carries payment_id.
CREATE OR REPLACE FUNCTION check_allocation_covers_payment() RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_payment_fully_allocated(COALESCE(NEW.payment_id, OLD.payment_id));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Fired from the payment row, whose own key is `id`. This is the case that
-- catches a payment inserted with no allocations at all, which the allocation
-- trigger cannot see because no allocation row ever arrives.
CREATE OR REPLACE FUNCTION check_payment_is_allocated() RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_payment_fully_allocated(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS receipt_allocations_cover_payment ON receipt_allocations;
DROP TRIGGER IF EXISTS payments_are_allocated ON payments;
DROP FUNCTION IF EXISTS check_payment_allocated();

CREATE CONSTRAINT TRIGGER receipt_allocations_cover_payment
  AFTER INSERT OR UPDATE ON receipt_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_allocation_covers_payment();

CREATE CONSTRAINT TRIGGER payments_are_allocated
  AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_is_allocated();

COMMIT;
