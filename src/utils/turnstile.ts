// Server-side verification of Cloudflare Turnstile tokens. The frontend
// solves the challenge client-side and sends the resulting token; this is
// the only step that actually proves a real browser handled the request,
// since the secret key here never reaches the browser.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
	success: boolean;
}

export async function verifyTurnstileToken(token: string, secretKey: string, remoteIp?: string): Promise<boolean> {
	if (!secretKey || !token) {
		return false;
	}

	const body = new URLSearchParams({ secret: secretKey, response: token });

	if (remoteIp) {
		body.set('remoteip', remoteIp);
	}

	try {
		const response = await fetch(SITEVERIFY_URL, {
			method: 'POST',
			body,
		});

		if (!response.ok) {
			return false;
		}

		const result = (await response.json()) as SiteverifyResponse;
		return result.success === true;
	} catch (error) {
		// Fail closed: if Cloudflare's siteverify endpoint is unreachable,
		// treat the request as unverified rather than letting it through.
		console.error({
			event: 'turnstile_verify_error',
			error: error instanceof Error ? error.message : 'Unknown error',
		});

		return false;
	}
}
