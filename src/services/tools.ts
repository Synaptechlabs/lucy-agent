// Function tools the model can call mid-conversation, plus the dispatcher
// that runs them. See the tool-calling loop in services/openai.ts.
import type { FunctionTool } from 'openai/resources/responses/responses';

const GITHUB_ORG = 'Synaptechlabs';
const GITHUB_REPOS_URL = `https://api.github.com/orgs/${GITHUB_ORG}/repos?sort=updated&per_page=6&type=public`;
const MAX_LEAD_MESSAGE_LENGTH = 2_000;
const MAX_CONTACT_METHOD_LENGTH = 500;

export const TOOLS: FunctionTool[] = [
	{
		type: 'function',
		name: 'contact_scott',
		description:
			"Record a visitor's message for Scott when they want to get in touch, hire him, collaborate, or follow up. Use this whenever someone expresses interest in contacting Scott directly, not for general questions about him.",
		strict: true,
		parameters: {
			type: 'object',
			properties: {
				message: {
					type: 'string',
					description: "The visitor's message or reason for reaching out.",
				},
				contactMethod: {
					type: ['string', 'null'],
					description: 'How Scott can reach them back (email, etc.), if they provided one.',
				},
			},
			required: ['message', 'contactMethod'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'get_github_activity',
		description:
			"Fetch Scott's most recently updated public GitHub repositories (name, description, language, star count, last updated) from the Synaptechlabs GitHub org. Use this when asked about Scott's current or recent projects, what he's working on, or his GitHub activity — his bio alone goes stale, this doesn't.",
		strict: true,
		parameters: {
			type: 'object',
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
];

interface ContactScottArgs {
	message?: unknown;
	contactMethod?: unknown;
}

interface GithubRepo {
	name: string;
	description: string | null;
	html_url: string;
	language: string | null;
	stargazers_count: number;
	updated_at: string;
}

export type ToolExecutor = (name: string, argumentsJson: string, fetchImpl?: typeof fetch) => Promise<string>;

export const executeTool: ToolExecutor = async (name, argumentsJson, fetchImpl = fetch) => {
	switch (name) {
		case 'contact_scott':
			return handleContactScott(argumentsJson);
		case 'get_github_activity':
			return handleGetGithubActivity(fetchImpl);
		default:
			return `Unknown tool: ${name}`;
	}
};

function handleContactScott(argumentsJson: string): string {
	let args: ContactScottArgs;

	try {
		args = JSON.parse(argumentsJson);
	} catch {
		return 'Could not record the message — the request was malformed.';
	}

	if (typeof args.message !== 'string' || args.message.trim().length === 0) {
		return 'No message was provided to record.';
	}

	// Visible in Cloudflare's Worker logs / `wrangler tail` — no email or
	// storage wired up yet, this is the lead-capture MVP.
	console.log({
		event: 'lead_captured',
		message: args.message.trim().slice(0, MAX_LEAD_MESSAGE_LENGTH),
		contactMethod: typeof args.contactMethod === 'string' ? args.contactMethod.trim().slice(0, MAX_CONTACT_METHOD_LENGTH) : null,
		timestamp: new Date().toISOString(),
	});

	return 'The message has been recorded.';
}

async function handleGetGithubActivity(fetchImpl: typeof fetch): Promise<string> {
	try {
		const response = await fetchImpl(GITHUB_REPOS_URL, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'lucy-agent',
			},
		});

		if (!response.ok) {
			return 'GitHub data is not available right now.';
		}

		const repos = (await response.json()) as GithubRepo[];

		if (repos.length === 0) {
			return 'No public repositories were found.';
		}

		return JSON.stringify(
			repos.map((repo) => ({
				name: repo.name,
				description: repo.description,
				url: repo.html_url,
				language: repo.language,
				stars: repo.stargazers_count,
				updatedAt: repo.updated_at,
			})),
		);
	} catch (error) {
		console.error({
			event: 'github_activity_fetch_error',
			error: error instanceof Error ? error.message : 'Unknown error',
		});

		return 'GitHub data is not available right now.';
	}
}
