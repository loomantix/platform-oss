/** @format */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setEventSink,
  emitToEventSink,
  hasEventSink,
  type EventSinkFn,
} from './event-sink';

describe('event-sink', () => {
  beforeEach(() => {
    setEventSink(null);
  });

  describe('setEventSink', () => {
    it('should register a sink callback', () => {
      const sink = vi.fn();
      setEventSink(sink);
      expect(hasEventSink()).toBe(true);
    });

    it('should unregister when called with null', () => {
      setEventSink(vi.fn());
      setEventSink(null);
      expect(hasEventSink()).toBe(false);
    });

    it('should replace previous sink on subsequent calls', () => {
      const sink1 = vi.fn();
      const sink2 = vi.fn();
      setEventSink(sink1);
      setEventSink(sink2);

      emitToEventSink({ event: 'test_event' }, 'test');

      expect(sink1).not.toHaveBeenCalled();
      expect(sink2).toHaveBeenCalledOnce();
    });
  });

  describe('emitToEventSink', () => {
    it('should forward entries with an event field to the sink', () => {
      const sink = vi.fn();
      setEventSink(sink);

      emitToEventSink(
        { event: 'encounter_created', userId: 'u1' },
        'Encounter created',
      );

      expect(sink).toHaveBeenCalledWith({
        event: 'encounter_created',
        userId: 'u1',
        msg: 'Encounter created',
      });
    });

    it('should not forward entries without an event field', () => {
      const sink = vi.fn();
      setEventSink(sink);

      emitToEventSink({ userId: 'u1', action: 'login' }, 'User logged in');

      expect(sink).not.toHaveBeenCalled();
    });

    it('should not throw when no sink is registered', () => {
      expect(() => emitToEventSink({ event: 'test' }, 'test')).not.toThrow();
    });

    it('should catch and swallow sink errors', () => {
      const errorSink: EventSinkFn = () => {
        throw new Error('Sink failure');
      };
      setEventSink(errorSink);

      expect(() => emitToEventSink({ event: 'test' }, 'test')).not.toThrow();
    });

    it('should pass a shallow copy to prevent mutation of original entry', () => {
      const sink = vi.fn();
      setEventSink(sink);

      const original = { event: 'test', value: 1 };
      emitToEventSink(original, 'test');

      const passedArg = sink.mock.calls[0]![0] as Record<string, unknown>;
      passedArg['extra'] = true;

      expect(original).not.toHaveProperty('extra');
    });
  });

  describe('hasEventSink', () => {
    it('should return false when no sink is registered', () => {
      expect(hasEventSink()).toBe(false);
    });

    it('should return true when a sink is registered', () => {
      setEventSink(vi.fn());
      expect(hasEventSink()).toBe(true);
    });
  });
});

describe('event-sink — credential redaction', () => {
  beforeEach(() => {
    setEventSink(null);
  });

  it('does not forward a bearer token when it is the only sensitive field', () => {
    // hasPHIFields returned false for this entry, so the raw object — token
    // and all — was handed to the sink without ever reaching logMetadata.
    const sink = vi.fn();
    setEventSink(sink);
    emitToEventSink({ event: 'auth.failed', authorization: 'Bearer abc123' });
    const entry = sink.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty('authorization');
    expect(JSON.stringify(entry)).not.toContain('abc123');
    expect(entry['authorizationLength']).toBe(13);
  });

  it('redacts credentials alongside PHI in a mixed entry', () => {
    const sink = vi.fn();
    setEventSink(sink);
    emitToEventSink({
      event: 'upload.failed',
      'x-api-key': 'sk_live_1',
      transcript: 'Patient reports chest pain.',
      encounterId: 'enc-1',
    });
    const entry = sink.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('sk_live_1');
    expect(serialized).not.toContain('chest pain');
    expect(entry['encounterId']).toBe('enc-1');
  });
});
