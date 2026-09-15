-- Jalankan sekali melalui Supabase SQL Editor sebagai administrator.
BEGIN;

GRANT DELETE ON gateway_sessions, gateway_rate_limits TO pddikti_gateway;

DELETE FROM gateway_sessions
WHERE revoked_at IS NOT NULL OR expires_at < NOW();

DELETE FROM gateway_rate_limits
WHERE expires_at < NOW();

COMMIT;
