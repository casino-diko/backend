import Link from 'next/link';
import { Pager, SortHeader } from '../list';
import { GAME_LABELS, GAMES } from '@/lib/config';
import { dateTime, money, signed } from '@/lib/format';
import { listRounds } from '@/lib/rounds';
import { PAGE_SIZES, parseRoundQuery, roundsHref, type RoundQuery, type Sort, type StatusFilter } from '@/lib/roundQuery';
import { cardsText, resultText, STATUS_LABELS } from '@/lib/roundText';
import { requireAdmin } from '@/lib/session';

type Props = { searchParams : Promise<Record<string, string | string[] | undefined>> };

const CHIPS: { key : StatusFilter; label : string; count : string }[] = [
	{ key : '', label : 'All', count : 'all' },
	{ key : 'E', label : 'Successful', count : 'E' },
	{ key : 'C', label : 'Cancelled', count : 'C' },
	{ key : 'V', label : 'Voided', count : 'V' },
	{ key : 'open', label : 'In progress', count : 'open' }
];

export default async function RoundsPage ({ searchParams }: Props) {
	await requireAdmin();
	const query = parseRoundQuery(await searchParams);
	const result = await listRounds(query);
	const shown: RoundQuery = { ...query, page : result.page };
	const filtered = !!(query.game || query.status || query.table || query.dealer || query.round || query.from || query.to);
	const href = (changes: { sort? : Sort; dir? : 'asc' | 'desc'; page? : number }) => roundsHref(shown, changes);
	const tableIds = [...new Set(result.tables.filter(t => !query.game || t.game === query.game).map(t => t.id))].sort((a, b) => a - b);
	const sortHead = (sort: Sort, label: string, num = false) =>
		<SortHeader current={query.sort} dir={query.dir} href={href} sort={sort} label={label} num={num} />;

	return (
		<>
			<h1>Rounds</h1>
			<form className="panel row" method="get">
				<label>Game
					<select name="game" defaultValue={query.game}>
						<option value="">all games</option>
						{GAMES.map(g => <option key={g} value={g}>{GAME_LABELS[g]}</option>)}
					</select>
				</label>
				<label>Table
					<select name="table" defaultValue={query.table ?? ''}>
						<option value="">all tables</option>
						{tableIds.map(id => <option key={id} value={id}>Table {id}</option>)}
					</select>
				</label>
				<label>Dealer
					<select name="dealer" defaultValue={query.dealer ?? ''}>
						<option value="">anyone</option>
						{[...result.dealers].map(([id, d]) => <option key={id} value={id}>{d.name}{d.code ? ` · ${d.code}` : ''}</option>)}
					</select>
				</label>
				<label>Round #<input name="round" defaultValue={query.round ?? ''} inputMode="numeric" placeholder="e.g. 1088" size={8} /></label>
				<label>From (UTC)<input type="date" name="from" defaultValue={query.from} /></label>
				<label>To<input type="date" name="to" defaultValue={query.to} /></label>
				<label>Per page
					<select name="size" defaultValue={query.size}>
						{PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
					</select>
				</label>
				{/* keep the status and the sort order when filtering */}
				<input type="hidden" name="status" value={query.status} />
				<input type="hidden" name="sort" value={query.sort} />
				<input type="hidden" name="dir" value={query.dir} />
				<button type="submit" className="secondary">Filter</button>
				{filtered && <Link href={roundsHref({ ...query, game : '', status : '', table : null, dealer : null, round : null, from : '', to : '', page : 1 })}>Reset</Link>}
			</form>

			<nav className="chips" aria-label="Status">
				{CHIPS.map(c => (
					<Link key={c.label} href={roundsHref(query, { status : c.key, page : 1 })} aria-current={query.status === c.key ? 'true' : undefined}>
						{c.label} <span className="count">{(result.counts[c.count] || 0).toLocaleString('en-US')}</span>
					</Link>
				))}
			</nav>

			<div className="panel scroll">
				<p className="totals">
					<span><b>{result.total.toLocaleString('en-US')}</b> round{result.total === 1 ? '' : 's'}</span>
					<span>Bets <b>{money(result.totals.bets)}</b></span>
					<span>Winnings paid <b>{money(result.totals.payout)}</b></span>
					<span>House net <b className={result.totals.net < 0 ? 'neg' : undefined}>{signed(result.totals.net)}</b></span>
					<span>Stakes refunded <b>{money(result.totals.refunded)}</b></span>
					<span>Winnings reversed <b>{money(result.totals.reversed)}</b></span>
				</p>
				<table>
					<thead>
						<tr>
							<th>Table</th>
							{sortHead('round', 'Round')}
							{sortHead('time', 'Time (UTC)')}
							<th>Dealer</th>
							<th>Status</th>
							<th>Result</th>
							{sortHead('players', 'Players', true)}
							{sortHead('bets', 'Bets', true)}
							{sortHead('payout', 'Winnings paid', true)}
							{sortHead('net', 'House net', true)}
							{sortHead('refunded', 'Refunded', true)}
						</tr>
					</thead>
					<tbody>
						{result.rows.map(r => {
							const dealer = r.dealer_id ? result.dealers.get(r.dealer_id) : null;
							const res = resultText(r.game, r.game_result);
							return (
								<tr key={`${r.game}-${r._id}`}>
									<td className="nowrap">{GAME_LABELS[r.game]} {r.table_id}</td>
									<td><Link href={`/rounds/${r.game}/${r._id}`}>{r.round_num}</Link></td>
									<td className="muted nowrap">{dateTime(r.created_at)}</td>
									<td className="nowrap">{dealer?.name ?? ''}</td>
									<td><span className={`pill st-${r.status}`}>{STATUS_LABELS[r.status] || r.status}</span></td>
									<td className="result">
										{r.status === 'C' ? <span className="muted">No result</span>
											: ['S', 'P', 'H'].includes(r.status) ? <span className="muted">In progress</span>
											: <span className={r.status === 'V' ? 'struck' : undefined} title={cardsText(r.game, r.game_info)}>{res}</span>}
										{r.closed?.reason && <small className="muted">{r.closed.reason}</small>}
									</td>
									<td className="num">{r.players}</td>
									<td className="num">{money(r.bets)}</td>
									<td className="num">{money(r.payout)}</td>
									<td className={`num${r.net < 0 ? ' neg' : ''}`}>{r.status === 'E' ? signed(r.net) : <span className="muted">0</span>}</td>
									<td className="num">
										{r.refunded ? money(r.refunded) : <span className="muted">0</span>}
										{r.reversed > 0 && <small className="muted">−{money(r.reversed)} winnings</small>}
									</td>
								</tr>
							);
						})}
						{!result.rows.length && <tr><td colSpan={11} className="muted">No rounds{filtered ? ' match these filters' : ''}.</td></tr>}
					</tbody>
				</table>

				<Pager page={result.page} pages={result.pages} size={query.size} total={result.total} shown={result.rows.length} href={page => href({ page })} />
			</div>
		</>
	);
}
