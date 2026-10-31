import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Invalid } from '../src/lib/validate.ts';
import { checkUpload, parseName, sniff } from '../src/lib/brandRules.ts';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const svg = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]);
const mp3frame = Buffer.from([0xff, 0xfb, 0x90, 0x64]);

test('sniff tells images and mp3 apart by their bytes', () => {
	assert.equal(sniff(png), 'image/png');
	assert.equal(sniff(jpeg), 'image/jpeg');
	assert.equal(sniff(webp), 'image/webp');
	assert.equal(sniff(svg), 'image/svg+xml');
	assert.equal(sniff(Buffer.from('<svg viewBox="0 0 1 1"/>')), 'image/svg+xml');
	assert.equal(sniff(mp3), 'audio/mpeg');
	assert.equal(sniff(mp3frame), 'audio/mpeg');
	assert.equal(sniff(Buffer.from('<html><body>')), null);
	assert.equal(sniff(Buffer.from('GIF89a')), null);
});

test('checkUpload: images for logo and icon, mp3 for sounds, within size', () => {
	assert.equal(checkUpload('logo', png), 'image/png');
	assert.equal(checkUpload('icon', svg), 'image/svg+xml');
	assert.equal(checkUpload('welcome', mp3), 'audio/mpeg');
	assert.equal(checkUpload('welcome-kr', mp3frame), 'audio/mpeg');
	const bad: [string, Buffer][] = [['logo', mp3], ['welcome', png], ['logo', Buffer.alloc(0)], ['logo', Buffer.from('<html>')],
		['favicon', png], ['logo', Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)])], ['welcome', Buffer.concat([mp3, Buffer.alloc(5 * 1024 * 1024)])]];
	for (const [id, data] of bad) assert.throws(() => checkUpload(id, data), Invalid, `${id} ${data.length}`);
});

test('parseName: 1 to 40 characters, no markup characters', () => {
	assert.equal(parseName('  Royal   Club '), 'Royal Club');
	assert.equal(parseName('Diko'), 'Diko');
	for (const bad of ['', '   ', 'x'.repeat(41), '<b>Diko</b>', 'A & B', 'say "hi"']) assert.throws(() => parseName(bad), Invalid, bad);
});
