// End-to-end coverage of the Worker's routing (via SELF.fetch) plus focused
// unit coverage of handleChatRequest's validation branches via a fake reply generator.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handleChatRequest } from '../src/routes/chat';

// index.ts rejects POST /chat outright on a disallowed Origin, so every
// SELF.fetch POST /chat call below needs one of the allowed origins.
const ORIGIN_HEADERS = { Origin: 'http://localhost:5173' };

// Fake Turnstile verifier for tests that need to get past the bot check
// without hitting Cloudflare's real siteverify endpoint.
const alwaysVerified = async (): Promise<boolean> => true;

// Reads a /chat SSE response body and parses each "data: {...}" event.
async function readSseEvents(response: Response): Promise<Record<string, unknown>[]> {
	const text = await response.text();

	return text
		.split('\n\n')
		.filter((chunk) => chunk.startsWith('data: '))
		.map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

describe('Lucy Worker', () => {
	it("returns Lucy's health status", async () => {
		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: 'ok',
			assistant: 'Lucy',
			message: 'Lucy is alive!',
		});
	});

	it('returns 404 for an unknown route', async () => {
		const response = await SELF.fetch('https://example.com/unknown');

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: 'Not found',
		});
	});

	it('rejects unsupported methods on the root route', async () => {
		const response = await SELF.fetch('https://example.com/', {
			method: 'POST',
		});

		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({
			error: 'Method not allowed',
		});
	});

	it('accepts a preflight request from an allowed origin', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'OPTIONS',
			headers: {
				Origin: 'http://localhost:5173',
				'Access-Control-Request-Method': 'POST',
			},
		});

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
	});

	it('rejects a preflight request from an unknown origin', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://malicious.example',
				'Access-Control-Request-Method': 'POST',
			},
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: 'Origin not allowed',
		});
	});

	it('rejects GET requests to the chat route', async () => {
		const response = await SELF.fetch('https://example.com/chat');

		expect(response.status).toBe(405);

		const body = (await response.json()) as {
			error: string;
			requestId: string;
		};

		expect(body.error).toBe('Method not allowed');
		expect(body.requestId).toBeTypeOf('string');
	});

	it('rejects a chat request with no Origin header', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ message: 'Hello' }),
		});

		expect(response.status).toBe(403);

		const body = (await response.json()) as { error: string };

		expect(body.error).toBe('Origin not allowed');
	});

	it('rejects a chat request from a disallowed Origin', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://malicious.example',
			},
			body: JSON.stringify({ message: 'Hello' }),
		});

		expect(response.status).toBe(403);

		const body = (await response.json()) as { error: string };

		expect(body.error).toBe('Origin not allowed');
	});

	it('requires an application/json content type', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'POST',
			headers: ORIGIN_HEADERS,
			body: 'hello',
		});

		expect(response.status).toBe(415);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe('Content-Type must be application/json');
	});

	it('rejects malformed JSON', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...ORIGIN_HEADERS,
			},
			body: '{"message":',
		});

		expect(response.status).toBe(400);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe('Request body contains invalid JSON');
	});

	it('rejects an empty message', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...ORIGIN_HEADERS,
			},
			body: JSON.stringify({
				message: '   ',
			}),
		});

		expect(response.status).toBe(400);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe('A non-empty message is required');
	});

	it('rejects messages longer than 4,000 characters', async () => {
		const response = await SELF.fetch('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...ORIGIN_HEADERS,
			},
			body: JSON.stringify({
				message: 'a'.repeat(4_001),
			}),
		});

		expect(response.status).toBe(413);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe('Message must not exceed 4000 characters');
	});
	it('returns a successful mocked streamed Lucy reply', async () => {
		async function* fakeReplyStreamer(apiKey: string, message: string, previousResponseId?: string) {
			expect(apiKey).toBe('test-api-key');
			expect(message).toBe('Who are you?');
			expect(previousResponseId).toBeUndefined();

			yield { type: 'delta' as const, text: 'I am ' };
			yield { type: 'delta' as const, text: 'Lucy.' };
			yield { type: 'done' as const, responseId: 'resp_first' };
		}

		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Origin: 'http://localhost:5173',
			},
			body: JSON.stringify({
				message: 'Who are you?',
				turnstileToken: 'test-token',
			}),
		});

		const response = await handleChatRequest(
			request,
			'test-api-key',
			'test-turnstile-secret',
			undefined,
			fakeReplyStreamer,
			alwaysVerified,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');

		const events = await readSseEvents(response);

		expect(events).toEqual([
			{ type: 'delta', text: 'I am ', requestId: expect.any(String) },
			{ type: 'delta', text: 'Lucy.', requestId: expect.any(String) },
			{ type: 'done', responseId: 'resp_first', requestId: expect.any(String) },
		]);
	});

	it('continues a conversation using the previous response ID', async () => {
		async function* fakeReplyStreamer(_apiKey: string, message: string, previousResponseId?: string) {
			expect(message).toBe('What did I just ask?');
			expect(previousResponseId).toBe('resp_first');

			yield { type: 'delta' as const, text: 'You asked who I am.' };
			yield { type: 'done' as const, responseId: 'resp_second' };
		}

		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'What did I just ask?',
				previousResponseId: 'resp_first',
				turnstileToken: 'test-token',
			}),
		});

		const response = await handleChatRequest(
			request,
			'test-api-key',
			'test-turnstile-secret',
			undefined,
			fakeReplyStreamer,
			alwaysVerified,
		);
		const events = await readSseEvents(response);

		expect(response.status).toBe(200);
		expect(events).toEqual([
			{ type: 'delta', text: 'You asked who I am.', requestId: expect.any(String) },
			{ type: 'done', responseId: 'resp_second', requestId: expect.any(String) },
		]);
	});

	it('rejects a chat request with no Turnstile token', async () => {
		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ message: 'Hello' }),
		});

		const response = await handleChatRequest(request, 'test-api-key', 'test-turnstile-secret');
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(body.error).toBe('turnstileToken is required');
	});

	it('logs a chat analytics event for a rejected request', async () => {
		const writeDataPoint = vi.fn();
		const analytics = { writeDataPoint } as unknown as AnalyticsEngineDataset;

		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ message: 'Hello' }),
		});

		await handleChatRequest(request, 'test-api-key', 'test-turnstile-secret', analytics);

		expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ indexes: ['missing_turnstile_token'] }));
	});

	it('rejects a chat request that fails Turnstile verification', async () => {
		const neverVerified = async (): Promise<boolean> => false;

		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ message: 'Hello', turnstileToken: 'bad-token' }),
		});

		const response = await handleChatRequest(request, 'test-api-key', 'test-turnstile-secret', undefined, undefined, neverVerified);
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(403);
		expect(body.error).toBe('Turnstile verification failed');
	});

	it('rejects an invalid previous response ID', async () => {
		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Continue our conversation',
				previousResponseId: 'not-a-response-id',
				turnstileToken: 'test-token',
			}),
		});

		const response = await handleChatRequest(request, 'test-api-key', 'test-turnstile-secret', undefined, undefined, alwaysVerified);
		const body = (await response.json()) as {
			error: string;
		};

		expect(response.status).toBe(400);
		expect(body.error).toBe('previousResponseId is invalid');
	});

	it('rejects a non-integer turnCount', async () => {
		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Hello',
				turnCount: 'not-a-number',
				turnstileToken: 'test-token',
			}),
		});

		const response = await handleChatRequest(request, 'test-api-key', 'test-turnstile-secret', undefined, undefined, alwaysVerified);
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(body.error).toBe('turnCount is invalid');
	});

	it('rejects a conversation that has reached the turn limit', async () => {
		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Hello',
				previousResponseId: 'resp_first',
				turnCount: 40,
				turnstileToken: 'test-token',
			}),
		});

		const response = await handleChatRequest(request, 'test-api-key', 'test-turnstile-secret', undefined, undefined, alwaysVerified);
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(body.error).toBe('This conversation has reached its turn limit. Please start a new one.');
	});

	it('allows a conversation below the turn limit', async () => {
		async function* fakeReplyStreamer() {
			yield { type: 'done' as const, responseId: 'resp_next' };
		}

		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Hello',
				previousResponseId: 'resp_first',
				turnCount: 39,
				turnstileToken: 'test-token',
			}),
		});

		const response = await handleChatRequest(
			request,
			'test-api-key',
			'test-turnstile-secret',
			undefined,
			fakeReplyStreamer,
			alwaysVerified,
		);

		expect(response.status).toBe(200);
	});
});
