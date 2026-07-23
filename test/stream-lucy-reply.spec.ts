// Drives streamLucyReply's tool-calling loop with a fake streaming OpenAI
// client and a fake tool executor — never calls the real OpenAI API.
import { describe, expect, it, vi } from 'vitest';
import type { Response as OpenAIResponse, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { inferReasoningEffort, streamLucyReply } from '../src/services/openai';

function fakeResponse(overrides: Partial<OpenAIResponse>): OpenAIResponse {
	return {
		id: 'resp_default',
		output: [],
		output_text: '',
		incomplete_details: null,
		...overrides,
	} as OpenAIResponse;
}

function deltaEvent(text: string): ResponseStreamEvent {
	return { type: 'response.output_text.delta', delta: text } as ResponseStreamEvent;
}

function completedEvent(response: OpenAIResponse): ResponseStreamEvent {
	return { type: 'response.completed', response } as ResponseStreamEvent;
}

async function* fakeStream(events: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
	for (const event of events) {
		yield event;
	}
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
	const results: T[] = [];

	for await (const event of generator) {
		results.push(event);
	}

	return results;
}

describe('inferReasoningEffort', () => {
	it('returns low effort for short messages', () => {
		expect(inferReasoningEffort('hi')).toBe('low');
		expect(inferReasoningEffort('who are you?')).toBe('low');
	});

	it('returns medium effort for mid-length messages', () => {
		expect(inferReasoningEffort('What has Scott been working on lately, in general terms?')).toBe('medium');
	});

	it('returns high effort for long messages', () => {
		const longMessage = 'word '.repeat(40).trim();
		expect(inferReasoningEffort(longMessage)).toBe('high');
	});
});

describe('streamLucyReply', () => {
	it('yields delta events then a done event when the model calls no tools', async () => {
		const createStream = vi
			.fn()
			.mockResolvedValue(
				fakeStream([deltaEvent('Hi '), deltaEvent('there.'), completedEvent(fakeResponse({ id: 'resp_1', output_text: 'Hi there.' }))]),
			);
		const runTool = vi.fn();

		const events = await collect(streamLucyReply('key', 'Hello', undefined, createStream, runTool));

		expect(events).toEqual([
			{ type: 'delta', text: 'Hi ' },
			{ type: 'delta', text: 'there.' },
			{ type: 'done', responseId: 'resp_1' },
		]);
		expect(createStream).toHaveBeenCalledTimes(1);
		expect(runTool).not.toHaveBeenCalled();
	});

	it('executes a requested tool and streams the follow-up reply', async () => {
		const createStream = vi
			.fn()
			.mockResolvedValueOnce(
				fakeStream([
					completedEvent(
						fakeResponse({
							id: 'resp_1',
							output: [{ type: 'function_call', call_id: 'call_1', name: 'get_github_activity', arguments: '{}' }],
						}),
					),
				]),
			)
			.mockResolvedValueOnce(
				fakeStream([
					deltaEvent('Here is what Scott has been building.'),
					completedEvent(fakeResponse({ id: 'resp_2', output_text: 'Here is what Scott has been building.' })),
				]),
			);
		const runTool = vi.fn().mockResolvedValue('[{"name":"lucy-agent"}]');

		const events = await collect(streamLucyReply('key', 'What is Scott working on?', undefined, createStream, runTool));

		expect(events).toEqual([
			{ type: 'delta', text: 'Here is what Scott has been building.' },
			{ type: 'done', responseId: 'resp_2' },
		]);
		expect(runTool).toHaveBeenCalledWith('get_github_activity', '{}');

		const secondCallParams = createStream.mock.calls[1][0];
		expect(secondCallParams.previous_response_id).toBe('resp_1');
		expect(secondCallParams.stream).toBe(true);
		expect(secondCallParams.input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: '[{"name":"lucy-agent"}]' }]);

		// Effort is computed once from the user's message and reused across
		// every tool round-trip, not recomputed from tool output content.
		const firstCallParams = createStream.mock.calls[0][0];
		expect(firstCallParams.reasoning.effort).toBe(inferReasoningEffort('What is Scott working on?'));
		expect(secondCallParams.reasoning.effort).toBe(firstCallParams.reasoning.effort);
	});

	it('stops after MAX_TOOL_ROUNDS to avoid an unbounded loop', async () => {
		const alwaysCallsATool = () =>
			fakeStream([
				completedEvent(
					fakeResponse({ output: [{ type: 'function_call', call_id: 'call_x', name: 'get_github_activity', arguments: '{}' }] }),
				),
			]);

		const createStream = vi.fn().mockImplementation(() => Promise.resolve(alwaysCallsATool()));
		const runTool = vi.fn().mockResolvedValue('some result');

		const events = await collect(streamLucyReply('key', 'Loop forever?', undefined, createStream, runTool));

		// 1 initial call + 4 tool rounds (MAX_TOOL_ROUNDS) = 5, never unbounded.
		expect(createStream).toHaveBeenCalledTimes(5);
		expect(events.at(-1)).toEqual({ type: 'done', responseId: 'resp_default' });
	});

	it('warns when the final reply was truncated by the output token cap', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const createStream = vi
			.fn()
			.mockResolvedValue(
				fakeStream([
					completedEvent(fakeResponse({ id: 'resp_1', output_text: 'cut off mid', incomplete_details: { reason: 'max_output_tokens' } })),
				]),
			);

		await collect(streamLucyReply('key', 'Say a lot', undefined, createStream, vi.fn()));

		expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'openai_reply_truncated' }));

		warnSpy.mockRestore();
	});

	it('throws if the stream reports a failure', async () => {
		const createStream = vi
			.fn()
			.mockResolvedValue(
				fakeStream([{ type: 'response.failed', response: fakeResponse({ error: { message: 'boom' } }) } as ResponseStreamEvent]),
			);

		await expect(collect(streamLucyReply('key', 'Hello', undefined, createStream, vi.fn()))).rejects.toThrow('boom');
	});
});
