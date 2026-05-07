/** @format */

import { detectPHI, hasPHIFields, logMetadata } from './phi-detector';

/**
 * Callback function type for the event sink.
 * Receives a structured log entry that contains an `event` field.
 */
export type EventSinkFn = (entry: Record<string, unknown>) => void;

/** Holds the currently registered event sink callback */
let eventSink: EventSinkFn | null = null;

/**
 * Register a callback to receive structured log events.
 * Only one sink can be active at a time; subsequent calls replace the previous sink.
 * Pass `null` to unregister.
 */
export function setEventSink(fn: EventSinkFn | null): void {
  eventSink = fn;
}

/**
 * Forward a log entry to the registered event sink if one exists.
 * Only entries with an `event` field are forwarded.
 * PHI fields are automatically stripped before forwarding to prevent unencrypted PHI in S3.
 * Fire-and-forget: errors are caught and silently swallowed to never affect logging.
 */
export function emitToEventSink(
  entry: Record<string, unknown>,
  message?: string,
): void {
  // Check presence of `event` rather than truthiness — an event named ''
  // (empty string) is still a legitimate event field per the docs.
  if (!eventSink || !('event' in entry)) {
    return;
  }

  try {
    const safeEntry = hasPHIFields(entry)
      ? (logMetadata(entry) as Record<string, unknown>)
      : entry;
    const safeMsg =
      message !== undefined && detectPHI(message) ? undefined : message;
    eventSink({ ...safeEntry, msg: safeMsg });
  } catch {
    // Fire-and-forget: never let sink errors affect the logging pipeline
  }
}

/**
 * Returns whether an event sink is currently registered.
 * Useful for testing and diagnostics.
 */
export function hasEventSink(): boolean {
  return eventSink !== null;
}
