// Verifies checkChatRateLimit derives its key from CF-Connecting-IP and
// correctly propagates the rate limiter binding's success/failure result.
import { describe, expect, it, vi } from 'vitest';
import { checkChatRateLimit } from '../src/utils/rate-limit';

describe('chat rate limiting', () => {
	it('uses the Cloudflare connecting IP as the rate-limit key', async () => {
		const limit = vi.fn().mockResolvedValue({
			success: true,
		});

		const rateLimiter = {
			limit,
		} as unknown as RateLimit;

		const request = new Request('https://example.com/chat', {
			method: 'POST',
			headers: {
				'CF-Connecting-IP': '203.0.113.42',
			},
		});

		const allowed = await checkChatRateLimit(request, rateLimiter);

		expect(allowed).toBe(true);
		expect(limit).toHaveBeenCalledWith({
			key: 'chat:203.0.113.42',
		});
	});

	it('returns false when the rate limiter rejects the request', async () => {
		const rateLimiter = {
			limit: vi.fn().mockResolvedValue({
				success: false,
			}),
		} as unknown as RateLimit;

		const request = new Request('https://example.com/chat', {
			headers: {
				'CF-Connecting-IP': '203.0.113.43',
			},
		});

		const allowed = await checkChatRateLimit(request, rateLimiter);

		expect(allowed).toBe(false);
	});
});
