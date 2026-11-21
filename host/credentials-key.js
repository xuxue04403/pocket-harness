// Credential key rules, mirrored from `@deepseek-ai/dsh-credentials`.
//
// The plugin cannot import that package: it only resolves inside the running
// Harness, which would make this file impossible to exercise from plain node.
// The rules themselves are tiny and stable — a scope and an id, each a lowercase
// hyphenated segment — so they are restated here rather than reached for.
//
// Keeping the shape identical matters: a key this file accepts but the service
// rejects would surface as a confusing write failure at pairing time.

/** A scope or id segment, exactly as the credentials service spells it. */
export const CREDENTIAL_KEY_SEGMENT = /^[a-z][a-z0-9-]*$/

/** True when [value] may be used as one segment of a credential key. */
export function isCredentialKeySegment(value) {
  return typeof value === 'string' && CREDENTIAL_KEY_SEGMENT.test(value)
}

/**
 * Joins a scope and an id into the key the credentials service indexes by.
 *
 * Throws rather than silently building a key the service would reject, so a
 * typo shows up where it is made instead of at the first write.
 */
export function credentialKey(scope, id) {
  for (const segment of [scope, id]) {
    if (!isCredentialKeySegment(segment)) {
      throw new TypeError(`credential key segment "${String(segment)}" must match ${String(CREDENTIAL_KEY_SEGMENT)}`)
    }
  }
  return `${scope}/${id}`
}

/** Splits a credential key back into its scope and id. */
export function parseCredentialKey(value) {
  if (typeof value !== 'string') throw new TypeError('a credential key must be a string')
  const parts = value.split('/')
  if (parts.length !== 2 || !isCredentialKeySegment(parts[0]) || !isCredentialKeySegment(parts[1])) {
    throw new TypeError(`credential key "${value}" must be "<scope>/<id>"`)
  }
  return { scope: parts[0], id: parts[1] }
}

/** The scope of a credential key. */
export function credentialKeyScope(value) {
  return parseCredentialKey(value).scope
}

/** The id of a credential key. */
export function credentialKeyId(value) {
  return parseCredentialKey(value).id
}
