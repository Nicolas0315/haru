import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Length-equalising constant-time comparison of two secrets. Shared by
 * both services' bearer gates; this is a security boundary, so there
 * must be exactly one implementation to harden.
 */
export function isSameSecret(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Framework-agnostic bearer-token check. An unset/empty expected token
 * means the surface is deliberately open (local development only; the
 * caller is expected to log a loud warning at boot).
 */
export function isBearerTokenValid(
  authorizationHeader: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (expectedToken === undefined || expectedToken === "") {
    return true;
  }
  // The auth scheme is case-insensitive per RFC 9110 ("bearer x" is
  // as valid as "Bearer x"); the credential itself is not. A bearer
  // credential is a single b64token (no interior whitespace). Accept
  // RFC 9110 optional whitespace (SP / HTAB) around it so a
  // tab-separated or trailing-padded header from a lenient client is
  // not spuriously rejected; the credential capture stays `\S+`.
  const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(authorizationHeader ?? "");
  const presented = match?.[1] ?? "";
  return presented !== "" && isSameSecret(presented, expectedToken);
}

/** Browser-only CSRF boundary for tokenless loopback development. */
export function isLocalBrowserOriginAllowed(
  origin: string | undefined,
  requestUrl: string,
): boolean {
  try {
    const target = new URL(requestUrl);
    // Enforce the Host boundary even when same-origin browser GETs omit Origin.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
      return false;
    // Native loopback clients do not send Origin.
    if (origin === undefined) return true;
    return new URL(origin).origin === target.origin;
  } catch {
    return false;
  }
}
