-- OPTIONAL DATA: the GSTINs the Association supplied for four flats.
--
-- Run docs/neon/016-apply.sql first (the column must exist). This file changes
-- existing owner rows, so read it before running it. The same can be done flat
-- by flat on the portal (Flats & owners > Edit contact > GSTIN); the portal
-- also writes the audit line, which this script does not.
--
--   20EC, 25WB : 19AAJCS2234A1ZO
--   24WB       : 19ADXPB9845N1ZG
--   27WA       : 19AAICK4500E1ZS   (owner name: Korecept (OPC) Private Limited)
--
-- STEP 1 (read-only): who holds these flats now, and how many flats each owner
-- holds. A GSTIN belongs to the owner record, so an owner who holds a second
-- flat gets it on that flat's bills too. Check the last column is what you expect.

SELECT f.flat_no, o.id AS owner_id, o.full_name, o.gstin,
       (SELECT count(*) FROM flat_ownership x WHERE x.owner_id = o.id AND x.held_until IS NULL) AS flats_held
  FROM flats f
  JOIN flat_ownership fo ON fo.flat_id = f.id AND fo.role = 'owner' AND fo.held_until IS NULL
  JOIN owners o ON o.id = fo.owner_id
 WHERE f.flat_no IN ('20EC', '25WB', '24WB', '27WA')
 ORDER BY f.flat_no;

-- STEP 2: apply (each statement changes one owner's row).

BEGIN;

UPDATE owners SET gstin = '19AAJCS2234A1ZO'
 WHERE id IN (SELECT fo.owner_id FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id
               WHERE f.flat_no IN ('20EC', '25WB') AND fo.role = 'owner' AND fo.held_until IS NULL);

UPDATE owners SET gstin = '19ADXPB9845N1ZG'
 WHERE id IN (SELECT fo.owner_id FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id
               WHERE f.flat_no = '24WB' AND fo.role = 'owner' AND fo.held_until IS NULL);

UPDATE owners SET gstin = '19AAICK4500E1ZS', full_name = 'Korecept (OPC) Private Limited'
 WHERE id IN (SELECT fo.owner_id FROM flat_ownership fo JOIN flats f ON f.id = fo.flat_id
               WHERE f.flat_no = '27WA' AND fo.role = 'owner' AND fo.held_until IS NULL);

COMMIT;
