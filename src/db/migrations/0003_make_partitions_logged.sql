DO $$
DECLARE
  partition_name text;
BEGIN
  FOR partition_name IN
    SELECT quote_ident(child.relname)
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    WHERE parent.relname = 'logs'
  LOOP
    EXECUTE format('ALTER TABLE %s SET LOGGED', partition_name);
  END LOOP;
END $$;
