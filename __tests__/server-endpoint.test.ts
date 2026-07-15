import { describe, expect, it } from 'vitest';
import { normalizeServerEndpoint } from '../src/server-endpoint';

describe('normalizeServerEndpoint', () => {
  it.each([
    ['localhost:8787', 'https://localhost:8787'],
    ['127.0.0.1:8787', 'https://127.0.0.1:8787'],
    ['[::1]:8787', 'https://[::1]:8787'],
    ['server.example.com', 'https://server.example.com'],
    ['https://server.example.com/', 'https://server.example.com'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeServerEndpoint(input)).toBe(expected);
  });

  it.each([
    ['', /requires a host/i],
    ['https://user:secret@server.example.com', /must not contain credentials/i],
    ['https://server.example.com/base', /must not contain a path/i],
    ['https://server.example.com?token=secret', /query string/i],
    ['ftp://server.example.com', /must use https/i],
    ['http://localhost:8787', /must use https/i],
    ['http://server.example.com', /must use https/i],
    ['0.0.0.0:8787', /wildcard address/i],
    ['0:8787', /wildcard address/i],
    ['[::]:8787', /wildcard address/i],
    ['[0:0:0:0:0:0:0:0]:8787', /wildcard address/i],
  ])('rejects unsafe endpoint %s', (input, expected) => {
    expect(() => normalizeServerEndpoint(input)).toThrow(expected);
  });

  it('does not echo malformed input that may contain credentials', () => {
    const secret = 'do-not-print-this';
    expect(() => normalizeServerEndpoint(`https://[broken/${secret}`)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(secret) }),
    );
  });
});
