'use strict';

/*
 |--------------------------------------------------------------------------
 | http
 |--------------------------------------------------------------------------
 | Minimal JSON POST helper (replaces the deprecated request-promise).
 | Resolves with the parsed body; rejects on network errors / non 2xx.
 |
 */

module.exports = {
	async postJson (url, body, timeoutMs = 10000) {
		if (!url) {
			return Promise.reject(new Error('no url configured'));
		}

		const res = await fetch(url, {
			method  : 'POST',
			headers : { 'content-type' : 'application/json' },
			body    : JSON.stringify(body),
			signal  : AbortSignal.timeout(timeoutMs)
		});

		const text = await res.text();
		if (!res.ok) {
			throw new Error(`POST ${url} failed: ${res.status} ${text.slice(0, 200)}`);
		}

		try {
			return JSON.parse(text);
		} catch (e) {
			return text;
		}
	}
};
