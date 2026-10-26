/** Match the literal Host authority, not a DNS resolution or a forwarded-host claim. */
export function isLocalBridgeHost(host: string | null, port: number): boolean {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host ?? "");
  return !!match && (match[1] === undefined || Number(match[1]) === port);
}
