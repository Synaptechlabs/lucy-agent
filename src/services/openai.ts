import OpenAI from "openai";

import { LUCY_SYSTEM_PROMPT } from "../prompts/lucy";

export async function generateLucyReply(
	apiKey: string,
	message: string,
): Promise<string> {
	const openai = new OpenAI({
		apiKey,
	});

	const response = await openai.responses.create({
		model: "gpt-5.6-luna",
		reasoning: {
			effort: "low",
		},
		instructions: LUCY_SYSTEM_PROMPT,
		input: message,
	});

	return response.output_text;
}
