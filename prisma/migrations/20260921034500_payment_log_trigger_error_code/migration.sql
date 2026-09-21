-- The append-only trigger originally raised SQLSTATE 23001 (restrict_violation). Prisma maps that
-- code to "Foreign key constraint violated", which points a developer at the wrong problem.
-- Re-create the function with the default raise_exception code (P0001) so Prisma surfaces the
-- real message: "payment_log is append-only: UPDATE is not allowed ...".
CREATE OR REPLACE FUNCTION payment_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_log is append-only: % is not allowed (add a new row instead)', TG_OP;
END;
$$;
