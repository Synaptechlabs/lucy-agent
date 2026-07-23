// Applies Cloudflare's native rate limiting binding, keyed per client, to the chat endpoint.
export async function checkChatRateLimit(request: Request, rateLimiter: RateLimit): Promise<boolean> {
	// CF-Connecting-IP is set by Cloudflare's edge in production; the X-Forwarded-For
	// fallback and "unknown-client" default only matter for local/dev requests.
	const clientIdentifier =
		request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown-client';

	const { success } = await rateLimiter.limit({
		key: `chat:${clientIdentifier}`,
	});

	return success;
}
