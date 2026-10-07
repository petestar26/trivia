import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { errorHandler } from './error-handler.js';
it('never logs or echoes a malformed JSON password fragment', async () => {
  const lines: string[] = [];
  const server = Fastify({
    logger: {
      level: 'trace',
      stream: new Writable({
        write(chunk, _enc, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    },
  });
  server.setErrorHandler(errorHandler);
  server.post('/login', async () => ({ ok: true }));
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"password": "synthetic-secret-123" broken}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('Invalid JSON body');
    expect(lines.join('')).not.toContain('synthetic');
    expect(response.body).not.toContain('synthetic');
  } finally {
    await server.close();
  }
});
