import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayParam, listHref, parseListQuery } from '../src/lib/transactionQuery.ts';

test('defaults: newest first, page 1, 50 per page', () => {
	assert.deepEqual(parseListQuery({}), {
		q : '', type : '', admin : '', from : '', to : '', sort : 'time', dir : 'desc', page : 1, size : 50
	});
});

test('keeps valid values', () => {
	const q = parseListQuery({ q : ' e2e ', type : 'debit', admin : 'admin', from : '2026-10-01', to : '2026-10-31', sort : 'change', dir : 'asc', page : '3', size : '100' });
	assert.deepEqual(q, { q : 'e2e', type : 'debit', admin : 'admin', from : '2026-10-01', to : '2026-10-31', sort : 'change', dir : 'asc', page : 3, size : 100 });
});

test('drops invalid values', () => {
	const q = parseListQuery({ type : 'refund', sort : 'user_id', dir : 'sideways', page : '-2', size : '7', from : '2026-02-30', to : 'yesterday' });
	assert.equal(q.type, '');
	assert.equal(q.sort, 'time');
	assert.equal(q.dir, 'desc');
	assert.equal(q.page, 1);
	assert.equal(q.size, 50);
	assert.equal(q.from, '');
	assert.equal(q.to, '');
	assert.equal(parseListQuery({ page : '2.5' }).page, 1);
});

test('takes the first of repeated params and swaps a reversed date range', () => {
	const q = parseListQuery({ type : ['credit', 'debit'], from : '2026-10-31', to : '2026-10-01' });
	assert.equal(q.type, 'credit');
	assert.equal(q.from, '2026-10-01');
	assert.equal(q.to, '2026-10-31');
});

test('dayParam only accepts real calendar days', () => {
	assert.equal(dayParam('2024-02-29'), '2024-02-29');
	assert.equal(dayParam('2026-02-29'), '');
	assert.equal(dayParam('2026-13-01'), '');
	assert.equal(dayParam('2026-1-1'), '');
});

test('listHref leaves out defaults and applies changes', () => {
	const q = parseListQuery({});
	assert.equal(listHref(q), '/transactions');
	assert.equal(listHref(q, { page : 2 }), '/transactions?page=2');
	assert.equal(listHref(parseListQuery({ q : 'a b', sort : 'admin', dir : 'asc', page : '4' }), { page : 1 }),
		'/transactions?q=a+b&sort=admin&dir=asc');
});

test('pageList shows the ends and two pages around the current one', async () => {
	const { pageList } = await import('../src/lib/listQuery.ts');
	assert.deepEqual(pageList(1, 1), [1]);
	assert.deepEqual(pageList(1, 3), [1, 2, 3]);
	assert.deepEqual(pageList(1, 10), [1, 2, 3, null, 10]);
	assert.deepEqual(pageList(6, 12), [1, null, 4, 5, 6, 7, 8, null, 12]);
	assert.deepEqual(pageList(4, 7), [1, 2, 3, 4, 5, 6, 7]);
});
