// Unit coverage for the Analytics Engine logging helper. Never touches a
// real AnalyticsEngineDataset binding — always a fake writeDataPoint.
import { describe, expect, it, vi } from 'vitest';
import { logChatEvent } from '../src/utils/analytics';

function fakeRequest(cf?: { country?: string; colo?: string }): Request {
	const request = new Request('https://example.com/chat', { method: 'POST' });
	Object.defineProperty(request, 'cf', { value: cf });
	return request;
}

describe('logChatEvent', () => {
	it('writes a data point with outcome, requestId, country, and colo', () => {
		const writeDataPoint = vi.fn();
		const analytics = { writeDataPoint } as unknown as AnalyticsEngineDataset;

		logChatEvent(analytics, fakeRequest({ country: 'AU', colo: 'SYD' }), 'turnstile_failed', 'req-123');

		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ['turnstile_failed'],
			blobs: ['turnstile_failed', 'req-123', 'AU', 'SYD'],
		});
	});

	it('falls back to "unknown" when cf properties are missing', () => {
		const writeDataPoint = vi.fn();
		const analytics = { writeDataPoint } as unknown as AnalyticsEngineDataset;

		logChatEvent(analytics, fakeRequest(undefined), 'stream_started', 'req-456');

		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ['stream_started'],
			blobs: ['stream_started', 'req-456', 'unknown', 'unknown'],
		});
	});

	it('does nothing when analytics is undefined', () => {
		expect(() => logChatEvent(undefined, fakeRequest(), 'rate_limited', 'req-789')).not.toThrow();
	});

	it('never throws even if writeDataPoint itself throws', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const analytics = {
			writeDataPoint: () => {
				throw new Error('Analytics Engine unavailable');
			},
		} as unknown as AnalyticsEngineDataset;

		expect(() => logChatEvent(analytics, fakeRequest(), 'origin_rejected', 'req-000')).not.toThrow();
		expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'analytics_write_error' }));

		errorSpy.mockRestore();
	});
});
