const MAX_BODY_LENGTH = 1000;

/** Appends the (truncated) issue/card body to an event description, if enabled and present. */
export function withBody(
  description: string,
  body: string | null | undefined,
  includeBody: boolean
): string {
  if (!includeBody || !body) return description;
  return `${description}\n\n---\n${body.replace(/\r\n/g, '\n').slice(0, MAX_BODY_LENGTH)}`;
}
