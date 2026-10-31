import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityHref, activitySources, compareRows, parseActivityQuery, type Row } from '../src/lib/activityQuery.ts';

test('defaults: everything, newest first, page 1, 50 per page', () => {
	assert.deepEqual(parseActivityQuery({}), { what : '', outcome : '', from : '', to : '', sort : 'time', dir : 'desc', page : 1, size : 50 });
});

test('keeps valid values, drops the rest', () => {
	assert.deepEqual(parseActivityQuery({ what : 'poker', outcome : 'open', sort : 'payout', dir : 'asc', page : '2', size : '25', from : '2026-10-01' }),
		{ what : 'poker', outcome : 'open', from : '2026-10-01', to : '', sort : 'payout', dir : 'asc', page : 2, size : 25 });
	const bad = parseActivityQuery({ what : 'slots', outcome : 'win', sort : 'balance', size : '30' });
	assert.equal(bad.what, '');
	assert.equal(bad.outcome, '');
	assert.equal(bad.sort, 'time');
	assert.equal(bad.size, 50);
});

test('old ?show= links still pick the list', () => {
	assert.equal(parseActivityQuery({ show : 'bets' }).what, 'bets');
	assert.equal(parseActivityQuery({ show : 'all' }).what, '');
});

test('activitySources: which collections a query reads', () => {
	assert.deepEqual(activitySources({ what : '', outcome : '' }), { credits : true, games : ['baccarat', 'dragontiger', 'poker'] });
	assert.deepEqual(activitySources({ what : 'credits', outcome : '' }), { credits : true, games : [] });
	assert.deepEqual(activitySources({ what : 'bets', outcome : 'gain' }), { credits : false, games : ['baccarat', 'dragontiger', 'poker'] });
	assert.deepEqual(activitySources({ what : 'dragontiger', outcome : '' }), { credits : false, games : ['dragontiger'] });
	// adjustments are never open
	assert.deepEqual(activitySources({ what : '', outcome : 'open' }), { credits : false, games : ['baccarat', 'dragontiger', 'poker'] });
	assert.deepEqual(activitySources({ what : 'credits', outcome : 'open' }), { credits : false, games : [] });
});

test('activityHref leaves out defaults', () => {
	const q = parseActivityQuery({});
	assert.equal(activityHref(7, q), '/users/7');
	assert.equal(activityHref(7, q, { what : 'bets', page : 3 }), '/users/7?what=bets&page=3');
});

const row = (sortValue: number | null, at: number, source = 'poker', id = 1): Row => ({ sortValue, at, source, id });

test('compareRows: by value, then time, then source and id; missing values lowest', () => {
	const rows = [row(10, 1), row(null, 5, 'credits'), row(-3, 2), row(10, 9), row(10, 9, 'baccarat', 4)];
	const desc = [...rows].sort((a, b) => compareRows(a, b, 'desc'));
	assert.deepEqual(desc.map(r => [r.sortValue, r.at, r.source]), [[10, 9, 'baccarat'], [10, 9, 'poker'], [10, 1, 'poker'], [-3, 2, 'poker'], [null, 5, 'credits']]);
	const asc = [...rows].sort((a, b) => compareRows(a, b, 'asc'));
	assert.deepEqual(asc.map(r => r.sortValue), [null, -3, 10, 10, 10]);
	assert.equal(compareRows(row(1, 1, 'poker', 2), row(1, 1, 'poker', 3), 'desc') > 0, true);
});

test('merging the first N of each sorted source gives the exact global page', () => {
	// random sources, each sorted like MongoDB would; page 3 of 7 from the merge of the first 21 of each
	let seed = 42;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
	for (const dir of ['asc', 'desc'] as const) {
		const sources = ['credits', 'baccarat', 'poker'].map(source => Array.from({ length : 40 }, (_, i) =>
			row(rnd() < 0.2 ? null : Math.round(rnd() * 20) - 10, Math.floor(rnd() * 30), source, i + 1)));
		const cmp = (a: Row, b: Row) => compareRows(a, b, dir);
		const all = sources.flat().sort(cmp);
		const merged = sources.flatMap(s => [...s].sort(cmp).slice(0, 21)).sort(cmp);
		assert.deepEqual(merged.slice(14, 21), all.slice(14, 21));
	}
});
