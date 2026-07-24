// Function tools the model can call mid-conversation, plus the dispatcher
// that runs them. See the tool-calling loop in services/openai.ts.
import type { FunctionTool } from 'openai/resources/responses/responses';

// Synaptechlabs is a GitHub User account, not an Organization — the /orgs/
// endpoint 404s for it, so this must use the /users/ repos endpoint instead.
// Unauthenticated requests to it only ever return public repos.
const GITHUB_USER = 'Synaptechlabs';
const GITHUB_REPOS_URL = `https://api.github.com/users/${GITHUB_USER}/repos?sort=updated&per_page=6`;
const MAX_LEAD_MESSAGE_LENGTH = 2_000;
const MAX_CONTACT_METHOD_LENGTH = 500;
const MAX_SITE_CONTENT_LENGTH = 6_000;

// Branding-only — appears in the "From" header of every lead notification
// email, not a secret. The actual send credentials are ResendConfig below.
const RESEND_FROM_EMAIL = 'lucy@mail.uvw.io';
const RESEND_API_URL = 'https://api.resend.com/emails';

const SITE_PAGES = {
	home: 'https://synaptechlabs.ai/',
	bio: 'https://synaptechlabs.ai/bio.html',
} as const;

type SitePage = keyof typeof SITE_PAGES;

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
			"Fetch Scott's most recently updated public GitHub repositories (name, description, language, star count, last updated) from his GitHub account. Use this when asked about Scott's current or recent projects, what he's working on, or his GitHub activity — his bio alone goes stale, this doesn't.",
		strict: true,
		parameters: {
			type: 'object',
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'get_site_content',
		description:
			"Fetch the current text content of a page on synaptechlabs.ai. 'bio' has Scott's career history, employers, and education — richer and more detailed than the assistant's own bio summary. 'home' has the current flagship project and a project log with status tags (active, research, legacy, etc.) that goes beyond what get_github_activity returns. Use this for career/background questions or anything about current projects that the other tools and the bio above don't fully cover, since the live site may have been updated more recently than this prompt.",
		strict: true,
		parameters: {
			type: 'object',
			properties: {
				page: {
					type: 'string',
					enum: ['home', 'bio'],
					description: 'Which page to fetch.',
				},
			},
			required: ['page'],
			additionalProperties: false,
		},
	},
];

interface ContactScottArgs {
	message?: unknown;
	contactMethod?: unknown;
}

// Injected so the real Resend credentials only flow through Worker secrets,
// never a default/hardcoded value — see makeToolExecutor below.
export interface ResendConfig {
	apiKey: string;
	toEmail: string;
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

// Builds a tool executor bound to a specific Resend config (or none, for
// tests and any environment where the secrets aren't set — contact_scott
// still logs the lead either way, email is additive, never a replacement).
export function makeToolExecutor(resendConfig: ResendConfig | undefined): ToolExecutor {
	return async (name, argumentsJson, fetchImpl = fetch) => {
		switch (name) {
			case 'contact_scott':
				return handleContactScott(argumentsJson, resendConfig, fetchImpl);
			case 'get_github_activity':
				return handleGetGithubActivity(fetchImpl);
			case 'get_site_content':
				return handleGetSiteContent(argumentsJson, fetchImpl);
			default:
				return `Unknown tool: ${name}`;
		}
	};
}

// The no-Resend-config executor — used as the default everywhere a caller
// doesn't have (or care about) real send credentials.
export const executeTool: ToolExecutor = makeToolExecutor(undefined);

async function handleContactScott(argumentsJson: string, resendConfig: ResendConfig | undefined, fetchImpl: typeof fetch): Promise<string> {
	let args: ContactScottArgs;

	try {
		args = JSON.parse(argumentsJson);
	} catch {
		return 'Could not record the message — the request was malformed.';
	}

	if (typeof args.message !== 'string' || args.message.trim().length === 0) {
		return 'No message was provided to record.';
	}

	const message = args.message.trim().slice(0, MAX_LEAD_MESSAGE_LENGTH);
	const contactMethod = typeof args.contactMethod === 'string' ? args.contactMethod.trim().slice(0, MAX_CONTACT_METHOD_LENGTH) : null;

	// The guaranteed record — visible in Cloudflare's Worker logs / `wrangler
	// tail` and queryable via Analytics Engine, regardless of whether the
	// email below succeeds, fails, or was never configured.
	console.log({
		event: 'lead_captured',
		message,
		contactMethod,
		timestamp: new Date().toISOString(),
	});

	if (resendConfig) {
		await sendLeadEmail(resendConfig, message, contactMethod, fetchImpl);
	}

	return 'The message has been recorded.';
}

// Best-effort notification on top of the log above — a failure here is
// logged but never thrown, and never changes what the model tells the visitor.
async function sendLeadEmail(
	resendConfig: ResendConfig,
	message: string,
	contactMethod: string | null,
	fetchImpl: typeof fetch,
): Promise<void> {
	try {
		const response = await fetchImpl(RESEND_API_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${resendConfig.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: RESEND_FROM_EMAIL,
				to: resendConfig.toEmail,
				subject: 'New Lucy chat lead',
				text: `Message: ${message}\n\nContact: ${contactMethod ?? 'not provided'}`,
			}),
		});

		if (!response.ok) {
			console.error({ event: 'lead_email_send_failed', status: response.status });
		}
	} catch (error) {
		console.error({
			event: 'lead_email_send_error',
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
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

async function handleGetSiteContent(argumentsJson: string, fetchImpl: typeof fetch): Promise<string> {
	let args: { page?: unknown };

	try {
		args = JSON.parse(argumentsJson);
	} catch {
		return 'Could not read the site content request — the request was malformed.';
	}

	const page = args.page as string;

	if (!isSitePage(page)) {
		return `Unknown page: ${String(args.page)}. Valid pages are "home" and "bio".`;
	}

	try {
		const response = await fetchImpl(SITE_PAGES[page]);

		if (!response.ok) {
			return 'Site content is not available right now.';
		}

		const html = await response.text();
		return htmlToText(html).slice(0, MAX_SITE_CONTENT_LENGTH);
	} catch (error) {
		console.error({
			event: 'site_content_fetch_error',
			page,
			error: error instanceof Error ? error.message : 'Unknown error',
		});

		return 'Site content is not available right now.';
	}
}

function isSitePage(value: unknown): value is SitePage {
	return typeof value === 'string' && value in SITE_PAGES;
}

// Strips scripts/styles first so their contents never leak into the text,
// then strips remaining tags and decodes the handful of entities the site uses.
function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}
