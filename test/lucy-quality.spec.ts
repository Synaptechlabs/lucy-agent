import { describe, expect, it } from 'vitest';

import { LUCY_SYSTEM_PROMPT } from '../src/prompts/lucy';
import { LUCY_MODEL } from '../src/services/openai';

/**
 * These checks protect Lucy's core behaviour from accidental prompt regressions.
 * They are deterministic guardrails; sampled model evaluations should be added once
 * representative production conversations are available.
 */
describe('Lucy quality guardrails', () => {
	it('uses a GPT-5.6 model tier', () => {
		expect(LUCY_MODEL).toMatch(/^gpt-5\.6-(sol|terra|luna)$/);
	});

	it.each([
		['verified identity', 'Scott Douglass is the founder'],
		['general knowledge', 'For general knowledge'],
		['uncertainty', 'If you do not know'],
		['privacy', 'private information'],
		['conversation context', 'earlier conversation turns'],
	])('keeps the %s instruction', (_name, instruction) => {
		expect(LUCY_SYSTEM_PROMPT).toContain(instruction);
	});
});
