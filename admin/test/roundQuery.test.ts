import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoundQuery, roundGames, roundsHref, statusMatch } from '../src/lib/roundQuery.ts';

test('defaults: every game and status, newest first, page 1, 50 per page', () => {
	assert.deepEqual(parseRoundQuery({}), {
		game : '', status : '', table : null, dealer : null, round : null,
		from : '', to : '', sort : 'time', dir : 'desc', page : 1, size : 50
	});
});

test('keeps valid values, drops the rest', () => {
	const q = parseRoundQuery({ game : 'poker', status : 'V', table : '2', dealer : '3', round : '#1088', sort : 'net', dir : 'asc', page : '4', size : '100' });
	assert.equal(q.game, 'poker');
	assert.equal(q.status, 'V');
	assert.equal(q.table, 2);
	assert.equal(q.dealer, 3);
	assert.equal(q.round, 1088);
	assert.equal(q.sort, 'net');
	assert.equal(q.dir, 'asc');
	assert.equal(q.page, 4);
	assert.equal(q.size, 100);

	const bad = parseRoundQuery({ game : 'slots', status : 'X', table : '0', dealer : '-1', round : '1.5', sort : 'admin' });
	assert.deepEqual([bad.game, bad.status, bad.table, bad.dealer, bad.round, bad.sort], ['', '', null, null, null, 'time']);
});

test('roundsHref leaves out defaults and applies changes', () => {
	const q = parseRoundQuery({ game : 'baccarat', status : 'C' });
	assert.equal(roundsHref(q), '/rounds?game=baccarat&status=C');
	assert.equal(roundsHref(q, { status : '', page : 2 }), '/rounds?game=baccarat&page=2');
	assert.equal(roundsHref(parseRoundQuery({})), '/rounds');
});

test('roundGames and statusMatch', () => {
	assert.deepEqual(roundGames({ game : '' }), ['baccarat', 'dragontiger', 'poker']);
	assert.deepEqual(roundGames({ game : 'dragontiger' }), ['dragontiger']);
	assert.equal(statusMatch(''), null);
	assert.equal(statusMatch('C'), 'C');
	assert.deepEqual(statusMatch('open'), { $in : ['S', 'P', 'H'] });
});
