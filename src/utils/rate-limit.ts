export async function checkChatRateLimit(
	request: Request,
	rateLimiter: RateLimit,
): Promise<boolean> {
	const clientIdentifier =
		request.headers.get("CF-Connecting-IP") ??
		
request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
		"unknown-client";

	const { success } = await rateLimiter.limit({
		key: `chat:${clientIdentifier}`,
	});

	return success;
}
