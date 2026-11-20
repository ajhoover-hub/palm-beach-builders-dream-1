-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- and authenticated directly, so REVOKE ... FROM PUBLIC alone left the queue
-- wrappers callable with the anon key through /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) FROM anon, authenticated;

-- Rate limits for the public submit-inquiry edge function.
-- Only the service role may read or write; the anon key has no access.
CREATE TABLE IF NOT EXISTS public.inquiry_submissions (
  id BIGSERIAL PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiry_submissions_created ON public.inquiry_submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_inquiry_submissions_ip ON public.inquiry_submissions(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_inquiry_submissions_email ON public.inquiry_submissions(email, created_at);

REVOKE ALL ON public.inquiry_submissions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inquiry_submissions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inquiry_submissions_id_seq TO service_role;

ALTER TABLE public.inquiry_submissions ENABLE ROW LEVEL SECURITY;

-- Counts and records a submission in one locked transaction so concurrent
-- requests cannot all pass the check before any of them is recorded.
CREATE OR REPLACE FUNCTION public.claim_inquiry_slot(p_ip_hash TEXT, p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized_email TEXT := lower(trim(p_email));
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('public.claim_inquiry_slot'));

  IF (SELECT count(*) FROM public.inquiry_submissions
      WHERE created_at > now() - interval '1 hour') >= 50 THEN
    RETURN FALSE;
  END IF;

  IF (SELECT count(*) FROM public.inquiry_submissions
      WHERE ip_hash = p_ip_hash AND created_at > now() - interval '1 hour') >= 5 THEN
    RETURN FALSE;
  END IF;

  IF (SELECT count(*) FROM public.inquiry_submissions
      WHERE email = normalized_email AND created_at > now() - interval '1 day') >= 3 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.inquiry_submissions (ip_hash, email) VALUES (p_ip_hash, normalized_email);
  DELETE FROM public.inquiry_submissions WHERE created_at < now() - interval '7 days';
  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_inquiry_slot(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_inquiry_slot(TEXT, TEXT) TO service_role;
