// Unit coverage for the tool dispatcher in src/services/tools.ts. GitHub
// calls are always driven through an injected fetch — never the real API.
import { describe, expect, it, vi } from 'vitest';
import { executeTool } from '../src/services/tools';

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

describe('unknown tool', () => {
	it('reports the tool name rather than throwing', async () => {
		const result = await executeTool('not_a_real_tool', '{}');

		expect(result).toBe('Unknown tool: not_a_real_tool');
	});
});
