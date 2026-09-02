export function commandPayload(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withBreak = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  return withBreak.replace(/\n/g, "\r");
}
