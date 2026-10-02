/**
 * Shared credential-ref naming helpers (issue #86): both the instance
 * settings form and the post-import provider-template fill dialog derive
 * env names from route ids with the same rules.
 */

/** The credential ref derived from a route id: uppercased, sanitized,
 * suffixed — `my_gw` becomes `MY_GW_API_KEY`. */
export function routeToEnvName(route: string): string {
  const clean = route
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return clean ? `${clean}_API_KEY` : ''
}
