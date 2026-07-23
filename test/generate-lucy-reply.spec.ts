// Drives generateLucyReply's tool-calling loop with a fake OpenAI client and
// a fake tool executor — never calls the real OpenAI or GitHub/Turnstile APIs.
import { describe, expect, it, vi } from 'vitest';
import type { Response as OpenAIResponse, ResponseInputItem } from 'openai/resources/responses/responses';
import { generateLucyReply } from '../src/services/openai';

function fakeResponse(overrides: Partial<OpenAIResponse>): OpenAIResponse {
	return {
		id: 'resp_default',
		output: [],
		output_text: '',
		incomplete_details: null,
		...overrides,
	} as OpenAIResponse;
}

describe('generateLucyReply tool-calling loop', () => {
	it('returns the reply directly when the model calls no tools', async () => {
		const createResponse = vi.fn().mockResolvedValue(fakeResponse({ id: 'resp_1', output_text: 'Hi there.' }));
		const runTool = vi.fn();

		const reply = await generateLucyReply('key', 'Hello', undefined, createResponse, runTool);

		expect(reply).toEqual({ text: 'Hi there.', responseId: 'resp_1' });
		expect(createResponse).toHaveBeenCalledTimes(1);
		expect(runTool).not.toHaveBeenCalled();
	});

	it('executes a requested tool and feeds the result back before returning', async () => {
		const firstResponse = fakeResponse({
			id: 'resp_1',
			output: [{ type: 'function_call', call_id: 'call_1', name: 'get_github_activity', arguments: '{}' }],
		});
		const secondResponse = fakeResponse({ id: 'resp_2', output_text: 'Here is what Scott has been building.' });

		const createResponse = vi.fn().mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(secondResponse);
		const runTool = vi.fn().mockResolvedValue('[{"name":"lucy-agent"}]');

		const reply = await generateLucyReply('key', 'What is Scott working on?', undefined, createResponse, runTool);

		expect(reply).toEqual({ text: 'Here is what Scott has been building.', responseId: 'resp_2' });
		expect(runTool).toHaveBeenCalledWith('get_github_activity', '{}');

		const secondCallParams = createResponse.mock.calls[1][0];
		expect(secondCallParams.previous_response_id).toBe('resp_1');
		expect(secondCallParams.input).toEqual([
			{ type: 'function_call_output', call_id: 'call_1', output: '[{"name":"lucy-agent"}]' },
		] satisfies ResponseInputItem[]);
	});

	it('stops after MAX_TOOL_ROUNDS to avoid an unbounded loop', async () => {
		const alwaysCallsATool = fakeResponse({
			output: [{ type: 'function_call', call_id: 'call_x', name: 'get_github_activity', arguments: '{}' }],
		});

		const createResponse = vi.fn().mockResolvedValue(alwaysCallsATool);
		const runTool = vi.fn().mockResolvedValue('some result');

		await generateLucyReply('key', 'Loop forever?', undefined, createResponse, runTool);

		// 1 initial call + 4 tool rounds (MAX_TOOL_ROUNDS) = 5, never unbounded.
		expect(createResponse).toHaveBeenCalledTimes(5);
	});

	it('warns when the final reply was truncated by the output token cap', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const createResponse = vi.fn().mockResolvedValue(
			fakeResponse({
				id: 'resp_1',
				output_text: 'cut off mid',
				incomplete_details: { reason: 'max_output_tokens' },
			}),
		);

		await generateLucyReply('key', 'Say a lot', undefined, createResponse, vi.fn());

		expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'openai_reply_truncated' }));

		warnSpy.mockRestore();
	});
});
