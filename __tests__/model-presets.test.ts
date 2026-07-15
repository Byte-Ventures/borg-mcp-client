import { describe, expect, it } from 'vitest';
import {
  MODEL_DESCRIPTOR_REGEX,
  parseModel,
  resolveLaunchEnv,
} from '../src/model-presets.js';

describe('legacy Claude model compatibility', () => {
  it('accepts and parses a Claude descriptor', () => {
    expect(MODEL_DESCRIPTOR_REGEX.test('claude:claude-opus-4-8')).toBe(true);
    expect(parseModel('claude:claude-opus-4-8')).toEqual({
      kind: 'claude',
      model: 'claude-opus-4-8',
    });
  });

  it('rejects provider descriptors owned by the agent CLI', () => {
    expect(MODEL_DESCRIPTOR_REGEX.test('ollama:qwen3-coder-next')).toBe(false);
    expect(() => parseModel('ollama:qwen3-coder-next')).toThrow(/expected claude:<model>/);
  });

  it('sets only ANTHROPIC_MODEL for the temporary Claude override', () => {
    expect(resolveLaunchEnv('claude:claude-sonnet-4-6')).toEqual({
      set: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
      unset: [],
    });
  });

  it('leaves the launch environment untouched without an override', () => {
    expect(resolveLaunchEnv(null)).toEqual({ set: {}, unset: [] });
  });
});
