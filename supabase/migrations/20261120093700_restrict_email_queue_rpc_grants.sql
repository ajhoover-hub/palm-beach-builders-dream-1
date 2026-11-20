-- Lock the email queue RPC wrappers down to service_role.
--
-- Supabase grants EXECUTE on every new public-schema function directly to
-- anon and authenticated (via default privileges), so revoking from PUBLIC
-- alone leaves them callable with the browser's publishable key. These
-- wrappers are SECURITY DEFINER and touch pgmq as the owner, so any caller
-- could enqueue arbitrary HTML mail, read queued messages, or drop them.

REVOKE EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) TO service_role;

ALTER FUNCTION public.enqueue_email(TEXT, JSONB) SET search_path = '';
ALTER FUNCTION public.read_email_batch(TEXT, INT, INT) SET search_path = '';
ALTER FUNCTION public.delete_email(TEXT, BIGINT) SET search_path = '';
ALTER FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) SET search_path = '';
