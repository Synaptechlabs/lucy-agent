// Wraps the OpenAI Responses API call that powers Lucy's replies: streams
// text deltas as they arrive and runs the function-calling loop for the
// tools defined in services/tools.ts transparently between rounds.
import OpenAI from 'openai';
import type {
	Response,
	ResponseCreateParamsBase,
	ResponseCreateParamsStreaming,
	ResponseInputItem,
	ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';

import { LUCY_SYSTEM_PROMPT } from '../prompts/lucy';
import { TOOLS, executeTool } from './tools';
import type { ToolExecutor } from './tools';

// Exported so tests can assert against it without duplicating the literal.
export const LUCY_MODEL = 'gpt-5.6-terra';

// Bounds cost and latency per reply. Reasoning tokens count against this
// budget too, so it needs headroom above what a plain-text reply needs.
const MAX_OUTPUT_TOKENS = 4_096;

// The OpenAI SDK defaults to a 10-minute timeout, far too long for a
// synchronous chat request — bound it so a hung upstream call fails fast.
const REQUEST_TIMEOUT_MS = 30_000;

// Caps how many tool round-trips a single chat turn can trigger, so a model
// stuck calling tools repeatedly can't turn one request into unbounded cost.
const MAX_TOOL_ROUNDS = 4;

// Word-count thresholds for the reasoning effort heuristic below. Crude —
// message length isn't the same as complexity — but far better than paying
// for "medium" reasoning on every "hi" and "thanks".
const LOW_EFFORT_MAX_WORDS = 6;
const HIGH_EFFORT_MIN_WORDS = 40;

// Scales reasoning effort to the message rather than using a fixed level for
// every turn. Computed once from the user's message and reused for every
// tool round-trip in that turn, not recomputed from tool output content.
export function inferReasoningEffort(message: string): ReasoningEffort {
	const wordCount = message.trim().split(/\s+/).filter(Boolean).length;

	if (wordCount <= LOW_EFFORT_MAX_WORDS) {
		return 'low';
	}

	if (wordCount >= HIGH_EFFORT_MIN_WORDS) {
		return 'high';
	}

	return 'medium';
}

export type LucyStreamEvent = { type: 'delta'; text: string } | { type: 'done'; responseId: string };

// Injected so tests can drive the tool-calling loop without hitting the real
// OpenAI API — see the fake used in test/stream-lucy-reply.spec.ts.
export type StreamCreator = (params: ResponseCreateParamsStreaming) => Promise<AsyncIterable<ResponseStreamEvent>>;

function buildRequestParams(
	input: string | ResponseInputItem[],
	effort: ReasoningEffort,
	previousResponseId?: string,
): ResponseCreateParamsBase {
	return {
		model: LUCY_MODEL,
		max_output_tokens: MAX_OUTPUT_TOKENS,
		reasoning: {
			effort,
			// Preserve useful reasoning context when the client continues a chat.
			context: 'all_turns',
		},
		instructions: LUCY_SYSTEM_PROMPT,
		input,
		tools: TOOLS,
		// OpenAI links the prior input and output without Lucy replaying the
		// complete transcript on every request.
		previous_response_id: previousResponseId,
	};
}

// Consumes one streamed response: yields a delta event per text chunk and
// returns (via the generator's return value, propagated through `yield*` in
// the caller) the completed Response once the stream ends. `response.output`
// on that completed Response carries any function_call items in full — no
// need to separately accumulate response.function_call_arguments.delta events.
async function* consumeStream(
	createStream: StreamCreator,
	params: ResponseCreateParamsStreaming,
): AsyncGenerator<LucyStreamEvent, Response> {
	const stream = await createStream(params);
	let finalResponse: Response | undefined;

	for await (const event of stream) {
		if (event.type === 'response.output_text.delta') {
			yield { type: 'delta', text: event.delta };
		} else if (event.type === 'response.completed') {
			finalResponse = event.response;
		} else if (event.type === 'response.failed') {
			throw new Error(`OpenAI response failed: ${event.response.error?.message ?? 'unknown error'}`);
		}
	}

	if (!finalResponse) {
		throw new Error('OpenAI stream ended without a completed response');
	}

	// Surfaces in logs if MAX_OUTPUT_TOKENS is cutting replies short, since a
	// truncated reply otherwise looks identical to a normal one to the caller.
	if (finalResponse.incomplete_details?.reason === 'max_output_tokens') {
		console.warn({
			event: 'openai_reply_truncated',
			responseId: finalResponse.id,
		});
	}

	return finalResponse;
}

export async function* streamLucyReply(
	apiKey: string,
	message: string,
	previousResponseId?: string,
	createStream: StreamCreator = defaultCreateStream(apiKey),
	runTool: ToolExecutor = executeTool,
): AsyncGenerator<LucyStreamEvent> {
	const effort = inferReasoningEffort(message);

	let response = yield* consumeStream(createStream, { ...buildRequestParams(message, effort, previousResponseId), stream: true });

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const functionCalls = response.output.filter((item) => item.type === 'function_call');

		if (functionCalls.length === 0) {
			break;
		}

		const toolOutputs: ResponseInputItem[] = await Promise.all(
			functionCalls.map(async (call) => ({
				type: 'function_call_output' as const,
				call_id: call.call_id,
				output: await runTool(call.name, call.arguments),
			})),
		);

		response = yield* consumeStream(createStream, { ...buildRequestParams(toolOutputs, effort, response.id), stream: true });
	}

	yield { type: 'done', responseId: response.id };
}

function defaultCreateStream(apiKey: string): StreamCreator {
	const openai = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
	return (params) => openai.responses.create(params);
}
