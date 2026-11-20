const SECRET_PARAMS =
  /^(code|token|access_token|refresh_token|id_token|state|key|api_key|apikey|password|secret|auth)$/i;

/** A request as the log shows it: secret-looking query values replaced. */
export function logRequest(req: { method?: string; url?: string; hostname?: string; ip?: string }) {
  return {
    method: req.method,
    url: redactUrl(req.url ?? ""),
    hostname: req.hostname,
    remoteAddress: req.ip,
  };
}

export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  for (const k of [...params.keys()]) if (SECRET_PARAMS.test(k)) params.set(k, "[redacted]");
  return `${url.slice(0, q)}?${params.toString()}`;
}
