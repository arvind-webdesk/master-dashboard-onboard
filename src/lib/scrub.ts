/**
 * Secret scrubber for strings about to be logged or persisted.
 *
 * Every line of git stdout/stderr and every error message that might contain a
 * token passes through here before hitting ProvisioningStepLog, the database,
 * or the status poll stream.
 *
 * Keep the pattern list aligned with .claude/hooks/protect-secrets.js.
 */

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'github-classic', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'x-access-token-url', re: /x-access-token:[^@\s]+@github\.com/gi },
  { name: 'bearer', re: /(bearer\s+)[A-Za-z0-9_\-\.=]{20,}/gi },
  { name: 'authorization-header', re: /(authorization\s*:\s*bearer\s+)[A-Za-z0-9_\-\.=]{20,}/gi },
  { name: 'pem', re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g },
  { name: 'aws-access', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'postgres-url', re: /(postgres(?:ql)?:\/\/[^:]+:)[^@\s]{6,}(@)/gi },
];

const REDACTED = '[REDACTED]';

/**
 * Replace every known secret pattern in `input` with a fixed redaction marker.
 * Safe to call on arbitrary user or tool output.
 */
export function scrub(input: string): string {
  let out = input;
  for (const { re } of PATTERNS) {
    out = out.replace(re, (_match, pre = '', post = '') => {
      // Some patterns have capture groups for "pre" and "post" context that we
      // want to preserve (e.g. "bearer " prefix or "...@" suffix).
      if (typeof pre === 'string' && typeof post === 'string' && (pre || post)) {
        return `${pre}${REDACTED}${post}`;
      }
      return REDACTED;
    });
  }
  return out;
}

/** Scrub + hard cap at N bytes. Returns a marker suffix when truncated. */
export function scrubAndTruncate(input: string, maxBytes = 8 * 1024): string {
  const scrubbed = scrub(input);
  if (Buffer.byteLength(scrubbed, 'utf8') <= maxBytes) return scrubbed;
  // Slice conservatively by character count to avoid splitting a multi-byte char.
  const sliced = scrubbed.slice(0, maxBytes);
  return `${sliced}\n… [truncated]`;
}
