// Wraps the OpenAI Responses API call that powers Lucy's replies.
import OpenAI from 'openai';

import { LUCY_SYSTEM_PROMPT } from '../prompts/lucy';
import type { LucyReply } from '../types';

// Exported so tests can assert against it without duplicating the literal.
export const LUCY_MODEL = 'gpt-5.6-terra';

// Bounds cost and latency per reply. Reasoning tokens count against this
// budget too, so it needs headroom above what a plain-text reply needs.
const MAX_OUTPUT_TOKENS = 4_096;

// The OpenAI SDK defaults to a 10-minute timeout, far too long for a
// synchronous chat request — bound it so a hung upstream call fails fast.
const REQUEST_TIMEOUT_MS = 30_000;

export async function generateLucyReply(apiKey: string, message: string, previousResponseId?: string): Promise<LucyReply> {
	const openai = new OpenAI({
		apiKey,
		timeout: REQUEST_TIMEOUT_MS,
	});

	const response = await openai.responses.create({
		model: LUCY_MODEL,
		max_output_tokens: MAX_OUTPUT_TOKENS,
		reasoning: {
			effort: 'medium',
			// Preserve useful reasoning context when the client continues a chat.
			context: 'all_turns',
		},
		instructions: LUCY_SYSTEM_PROMPT,
		input: message,
		// OpenAI links the prior input and output without Lucy replaying the
		// complete transcript on every request.
		previous_response_id: previousResponseId,
	});

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
