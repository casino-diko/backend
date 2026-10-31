/*
 |--------------------------------------------------------------------------
 | brand rules
 |--------------------------------------------------------------------------
 | What the Branding page accepts. Pure (no database), covered by
 | test/brandRules.test.ts.
 |
 */

import { Invalid } from './validate.ts';

export const DEFAULT_NAME = 'Diko';
export const WELCOME_LANGS = [
	{ code : 'en', label : 'English' }, { code : 'kr', label : 'Korean' }, { code : 'jp', label : 'Japanese' },
	{ code : 'zh', label : 'Chinese' }, { code : 'th', label : 'Thai' }
];
export const FILE_IDS = ['logo', 'icon', 'welcome', ...WELCOME_LANGS.map(l => `welcome-${l.code}`)];

const IMAGE_MAX = 2 * 1024 * 1024;
const SOUND_MAX = 5 * 1024 * 1024;

export function parseName (raw: unknown): string {
	const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
	if (!name || name.length > 40) throw new Invalid('Name: 1 to 40 characters');
	if (/[<>"'&]/.test(name)) throw new Invalid('Name: no < > " \' or &');
	return name;
}

/** the content type of an image or sound, from its first bytes; null when it is neither */
export function sniff (data: Buffer): string | null {
	if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
	if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
	const head = data.subarray(0, 512).toString('utf8').trimStart();
	if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
	if (data.length >= 3 && data.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
	if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'audio/mpeg';
	return null;
}

/** checks an upload for a file slot; returns its content type */
export function checkUpload (id: string, data: Buffer): string {
	if (!FILE_IDS.includes(id)) throw new Invalid('Unknown file');
	if (!data.length) throw new Invalid('Choose a file first');
	const type = sniff(data);
	if (id === 'logo' || id === 'icon') {
		if (!type?.startsWith('image/')) throw new Invalid('Upload a PNG, JPEG, WebP or SVG image');
		if (data.length > IMAGE_MAX) throw new Invalid('Images: at most 2 MB');
	} else {
		if (type !== 'audio/mpeg') throw new Invalid('Upload an MP3 file');
		if (data.length > SOUND_MAX) throw new Invalid('Sounds: at most 5 MB');
	}
	return type;
}
