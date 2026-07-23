// Raw shape of the POST /chat JSON body, before validation.
// Fields are typed `unknown` because they come straight from an untrusted client.
export interface ChatRequestBody {
	message?: unknown;
	previousResponseId?: unknown;
}

// Normalized result returned by the reply generator once OpenAI has responded.
export interface LucyReply {
	text: string;
	// Echoed back to the client as previousResponseId to continue the conversation.
	responseId: string;
}
