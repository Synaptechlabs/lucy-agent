// Unit coverage for the tool dispatcher in src/services/tools.ts. GitHub
// calls are always driven through an injected fetch — never the real API.
import { describe, expect, it, vi } from 'vitest';
import { executeTool, makeToolExecutor } from '../src/services/tools';

describe('contact_scott tool', () => {
	it('records a message and confirms it was recorded', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		const result = await executeTool(
			'contact_scott',
			JSON.stringify({ message: 'Interested in working together', contactMethod: 'me@example.com' }),
		);

		expect(result).toBe('The message has been recorded.');
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'lead_captured',
				message: 'Interested in working together',
				contactMethod: 'me@example.com',
			}),
		);

		logSpy.mockRestore();
	});

	it('accepts a null contactMethod without logging the literal null as a string', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		await executeTool('contact_scott', JSON.stringify({ message: 'Hello', contactMethod: null }));

		expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ contactMethod: null }));

		logSpy.mockRestore();
	});

	it('rejects an empty message without logging anything', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		const result = await executeTool('contact_scott', JSON.stringify({ message: '   ' }));

		expect(result).toBe('No message was provided to record.');
		expect(logSpy).not.toHaveBeenCalled();

		logSpy.mockRestore();
	});

	it('handles malformed JSON arguments gracefully', async () => {
		const result = await executeTool('contact_scott', '{not json');

		expect(result).toBe('Could not record the message — the request was malformed.');
	});

	it('never attempts to send email when no Resend config is provided', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const fakeFetch = vi.fn();

		await executeTool('contact_scott', JSON.stringify({ message: 'Hello' }), fakeFetch as unknown as typeof fetch);

		expect(fakeFetch).not.toHaveBeenCalled();

		logSpy.mockRestore();
	});

	it('sends a lead email via Resend when a config is provided', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const fakeFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		const executor = makeToolExecutor({ apiKey: 'test-resend-key', toEmail: 'scott@example.com' });

		const result = await executor(
			'contact_scott',
			JSON.stringify({ message: 'Interested in working together', contactMethod: 'me@example.com' }),
			fakeFetch as unknown as typeof fetch,
		);

		expect(result).toBe('The message has been recorded.');
		expect(fakeFetch).toHaveBeenCalledWith(
			'https://api.resend.com/emails',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ Authorization: 'Bearer test-resend-key' }),
			}),
		);

		const [, requestInit] = fakeFetch.mock.calls[0];
		const body = JSON.parse(requestInit.body as string);
		expect(body.from).toBe('lucy@mail.uvw.io');
		expect(body.to).toBe('scott@example.com');
		expect(body.text).toContain('Interested in working together');
		expect(body.text).toContain('me@example.com');

		logSpy.mockRestore();
	});

	it('still returns success and logs the lead even if the Resend send fails', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fakeFetch = vi.fn().mockRejectedValue(new Error('network down'));
		const executor = makeToolExecutor({ apiKey: 'test-resend-key', toEmail: 'scott@example.com' });

		const result = await executor('contact_scott', JSON.stringify({ message: 'Hello' }), fakeFetch as unknown as typeof fetch);

		expect(result).toBe('The message has been recorded.');
		expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'lead_captured' }));
		expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'lead_email_send_error' }));

		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it('logs when Resend responds with a non-ok status', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fakeFetch = vi.fn().mockResolvedValue(new Response('{"error":"invalid"}', { status: 422 }));
		const executor = makeToolExecutor({ apiKey: 'test-resend-key', toEmail: 'scott@example.com' });

		const result = await executor('contact_scott', JSON.stringify({ message: 'Hello' }), fakeFetch as unknown as typeof fetch);

		expect(result).toBe('The message has been recorded.');
		expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'lead_email_send_failed', status: 422 }));

		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});

describe('get_github_activity tool', () => {
	it('returns a compact summary of repos from the injected fetch', async () => {
		const fakeFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						name: 'lucy-agent',
						description: 'Personal AI assistant',
						html_url: 'https://github.com/Synaptechlabs/lucy-agent',
						language: 'TypeScript',
						stargazers_count: 3,
						updated_at: '2026-07-23T00:00:00Z',
					},
				]),
				{ status: 200 },
			),
		);

		const result = await executeTool('get_github_activity', '{}', fakeFetch as unknown as typeof fetch);
		const parsed = JSON.parse(result);

		expect(fakeFetch).toHaveBeenCalledWith(
			'https://api.github.com/users/Synaptechlabs/repos?sort=updated&per_page=6',
			expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'lucy-agent' }) }),
		);
		expect(parsed).toEqual([
			{
				name: 'lucy-agent',
				description: 'Personal AI assistant',
				url: 'https://github.com/Synaptechlabs/lucy-agent',
				language: 'TypeScript',
				stars: 3,
				updatedAt: '2026-07-23T00:00:00Z',
			},
		]);
	});

	it('fails closed with a plain message when the GitHub API errors', async () => {
		const fakeFetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));

		const result = await executeTool('get_github_activity', '{}', fakeFetch as unknown as typeof fetch);

		expect(result).toBe('GitHub data is not available right now.');
	});

	it('fails closed when fetch itself throws', async () => {
		const fakeFetch = vi.fn().mockRejectedValue(new Error('network down'));

		const result = await executeTool('get_github_activity', '{}', fakeFetch as unknown as typeof fetch);

		expect(result).toBe('GitHub data is not available right now.');
	});
});

describe('get_site_content tool', () => {
	it('fetches the requested page and strips tags/scripts/styles', async () => {
		const fakeFetch = vi.fn().mockResolvedValue(
			new Response(
				`<!DOCTYPE html><html><head><style>.x{color:red}</style><script>doStuff();</script></head>
				<body><h1>Scott Douglass</h1><p>CTO &amp; mathematics graduate.</p></body></html>`,
				{ status: 200 },
			),
		);

		const result = await executeTool('get_site_content', JSON.stringify({ page: 'bio' }), fakeFetch as unknown as typeof fetch);

		expect(fakeFetch).toHaveBeenCalledWith('https://synaptechlabs.ai/bio.html');
		expect(result).toBe('Scott Douglass CTO & mathematics graduate.');
		expect(result).not.toContain('doStuff');
		expect(result).not.toContain('color:red');
	});

	it('fetches the home page URL for the "home" page', async () => {
		const fakeFetch = vi.fn().mockResolvedValue(new Response('<p>Home content</p>', { status: 200 }));

		await executeTool('get_site_content', JSON.stringify({ page: 'home' }), fakeFetch as unknown as typeof fetch);

		expect(fakeFetch).toHaveBeenCalledWith('https://synaptechlabs.ai/');
	});

	it('rejects an unknown page value', async () => {
		const result = await executeTool('get_site_content', JSON.stringify({ page: 'admin' }));

		expect(result).toBe('Unknown page: admin. Valid pages are "home" and "bio".');
	});

	it('fails closed with a plain message on an HTTP error', async () => {
		const fakeFetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));

		const result = await executeTool('get_site_content', JSON.stringify({ page: 'bio' }), fakeFetch as unknown as typeof fetch);

		expect(result).toBe('Site content is not available right now.');
	});

	it('fails closed when fetch itself throws', async () => {
		const fakeFetch = vi.fn().mockRejectedValue(new Error('network down'));

		const result = await executeTool('get_site_content', JSON.stringify({ page: 'home' }), fakeFetch as unknown as typeof fetch);

		expect(result).toBe('Site content is not available right now.');
	});

	it('handles malformed JSON arguments gracefully', async () => {
		const result = await executeTool('get_site_content', '{not json');

		expect(result).toBe('Could not read the site content request — the request was malformed.');
	});
});

describe('unknown tool', () => {
	it('reports the tool name rather than throwing', async () => {
		const result = await executeTool('not_a_real_tool', '{}');

		expect(result).toBe('Unknown tool: not_a_real_tool');
	});
});
