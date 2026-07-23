// Wraps the OpenAI Responses API call that powers Lucy's replies, including
// the function-calling loop for the tools defined in services/tools.ts.
import OpenAI from 'openai';
import type { Response, ResponseCreateParamsNonStreaming, ResponseInputItem } from 'openai/resources/responses/responses';

import { LUCY_SYSTEM_PROMPT } from '../prompts/lucy';
import type { LucyReply } from '../types';
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

// Injected so tests can drive the tool-calling loop without hitting the real
// OpenAI API — see the fake used in test/services/openai.spec.ts.
export type ResponseCreator = (params: ResponseCreateParamsNonStreaming) => Promise<Response>;

function buildRequestParams(input: string | ResponseInputItem[], previousResponseId?: string): ResponseCreateParamsNonStreaming {
	return {
		model: LUCY_MODEL,
		max_output_tokens: MAX_OUTPUT_TOKENS,
		reasoning: {
			effort: 'medium',
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

export async function generateLucyReply(
	apiKey: string,
	message: string,
	previousResponseId?: string,
	createResponse: ResponseCreator = defaultCreateResponse(apiKey),
	runTool: ToolExecutor = executeTool,
): Promise<LucyReply> {
	let response = await createResponse(buildRequestParams(message, previousResponseId));

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

		response = await createResponse(buildRequestParams(toolOutputs, response.id));
	}

	// Surfaces in logs if MAX_OUTPUT_TOKENS is cutting replies short, since a
	// truncated reply otherwise looks identical to a normal one to the caller.
	if (response.incomplete_details?.reason === 'max_output_tokens') {
		console.warn({
			event: 'openai_reply_truncated',
			responseId: response.id,
		});
	}

	return {
		text: response.output_text,
		responseId: response.id,
	};
}

function defaultCreateResponse(apiKey: string): ResponseCreator {
	const openai = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
	return (params) => openai.responses.create(params);
}
