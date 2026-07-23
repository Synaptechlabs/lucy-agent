// Wraps the OpenAI Responses API call that powers Lucy's replies.
import OpenAI from 'openai';

import { LUCY_SYSTEM_PROMPT } from '../prompts/lucy';
import type { LucyReply } from '../types';

// Exported so tests can assert against it without duplicating the literal.
export const LUCY_MODEL = 'gpt-5.6-terra';

export async function generateLucyReply(apiKey: string, message: string, previousResponseId?: string): Promise<LucyReply> {
	const openai = new OpenAI({
		apiKey,
	});

	const response = await openai.responses.create({
		model: LUCY_MODEL,
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

	return {
		text: response.output_text,
		responseId: response.id,
	};
}
