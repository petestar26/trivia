import { it, expect, vi } from 'vitest';
import { answerSupport, assistantConfigured } from './assistant.js';
it('does not pretend AI is active without both key and model', async () => {
  const fetcher = vi.fn();
  expect(assistantConfigured({ OPENAI_API_KEY: 'x' })).toBe(false);
  await expect(answerSupport('help', 'am', {}, fetcher)).rejects.toThrow('not configured');
  expect(fetcher).not.toHaveBeenCalled();
});
it('sends only the question and curated facts, with storage disabled and bounded output', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: 'Open Wallet.' }] },
        ],
      }),
    });
  expect(
    await answerSupport(
      'How do I deposit?',
      'om',
      { OPENAI_API_KEY: 'test-secret', SUPPORT_AI_MODEL: 'configured-model' },
      fetcher
    )
  ).toEqual({ answer: 'Open Wallet.' });
  const [url, request] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/responses');
  const payload = JSON.parse(request.body);
  expect(payload).toMatchObject({
    model: 'configured-model',
    store: false,
    max_output_tokens: 900,
  });
  expect(payload.input).toContain('Language: om');
  expect(payload.instructions).toContain('cannot inspect accounts');
  expect(payload).not.toHaveProperty('tools');
});
it.each([{ ok: false }, { ok: true, json: async () => ({ output: [] }) }])(
  'returns a safe failure without leaking upstream details',
  async (response) => {
    await expect(
      answerSupport(
        'help',
        'en',
        { OPENAI_API_KEY: 'secret', SUPPORT_AI_MODEL: 'model' },
        vi.fn().mockResolvedValue(response)
      )
    ).rejects.toThrow('could not respond');
  }
);
