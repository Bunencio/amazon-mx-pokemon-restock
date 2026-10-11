/**
 * Strip session identifiers and CSRF tokens from captured Amazon HTML before it
 * is committed as a test fixture (the repo is public).
 */
const RULES = [
  [/(session-id=)\d{3}-\d{7}-\d{7}/g, '$1000-0000000-0000000'],
  [/("session-id"\s*:\s*")[^"]+(")/g, '$1000-0000000-0000000$2'],
  [/("sessionId"\s*:\s*")[^"]+(")/g, '$1REDACTED$2'],
  [/(sessionId:\s*")[^"]+(")/g, '$1REDACTED$2'],
  [/(ubid-acbmx=)[^;"&\s]+/g, '$1REDACTED'],
  [/(sst-acbmx=)[^;"&\s]+/g, '$1REDACTED'],
  [/(anti-csrftoken-a2z"\s+content=")[^"]+/g, '$1REDACTED'],
  [/(anti-csrftoken-a2z&quot;:&quot;)[^&]+/g, '$1REDACTED'],
  [/(anti-csrftoken-a2z"\s*:\s*")[^"]+/g, '$1REDACTED'],
  [/(\btoken:\s*")[^"]+(")/g, '$1REDACTED$2'],
  [/("token"\s*:\s*")[^"]+(")/g, '$1REDACTED$2'],
  [/(name="csrfToken"[^>]*value=")[^"]+/g, '$1REDACTED'],
  [/(ue_sid\s*=\s*')[^']+(')/g, '$1REDACTED$2'],
  [/(ue_mid\s*=\s*')[^']+(')/g, '$1REDACTED$2'],
  [/(ue_id\s*=\s*')[^']+(')/g, '$1REDACTED$2'],
  [/("requestId"\s*:\s*")[^"]+(")/g, '$1REDACTED$2'],
  [/(requestId:\s*")[^"]+(")/g, '$1REDACTED$2'],
  [/(visitId=)[0-9a-fA-F-]+/g, '$1REDACTED'],
  [/("visitId"\s*:\s*")[^"]+(")/g, '$1REDACTED$2'],
  [/("customerId"\s*:\s*")[^"]*(")/g, '$1$2'],
  [/(x-amz-rid[^A-Za-z0-9]{1,10})[A-Z0-9]{20}/g, '$1REDACTED'],
];

export function sanitizeHtml(html) {
  let out = String(html ?? '');
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}
