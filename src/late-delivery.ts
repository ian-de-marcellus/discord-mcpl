import { formatAgentDateTime, type TimestampStyle } from './timezone.js';

/** A message delivered more than this after Discord says it was sent is a
 *  late delivery (reconnect catch-up, a restored range, a delayed queue). */
export const LATE_DELIVERY_THRESHOLD_MS = 2 * 60 * 1000;

/** The line shown above a late message so it can't read as just-arrived:
 *  `[delayed delivery · sent <t> · received <t>]`, or '' when on time. */
export function lateDeliveryLine(
  sent: Date,
  received: Date,
  timeZone: string,
  style: TimestampStyle,
  thresholdMs: number = LATE_DELIVERY_THRESHOLD_MS,
): string {
  if (received.getTime() - sent.getTime() <= thresholdMs) return '';
  const fmt = (d: Date) => formatAgentDateTime(d, timeZone, style) || d.toISOString();
  return `[delayed delivery · sent ${fmt(sent)} · received ${fmt(received)}]\n`;
}
